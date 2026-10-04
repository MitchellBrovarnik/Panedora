// Minimal Rich Presence transport using Discord's documented local IPC protocol.
// https://discord.com/developers/docs/topics/rpc#rpc-over-ipc
// No OAuth, Discord user token, network listener, or native dependency is needed.
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const MAX_FRAME = 64 * 1024;

function ipcPaths(platform = process.platform, env = process.env) {
    if (platform === 'win32') return Array.from({ length: 10 }, (_, n) => `\\\\?\\pipe\\discord-ipc-${n}`);
    const directories = [...new Set([env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, '/tmp'].filter(Boolean))];
    // Flatpak Discord exposes its socket inside its app runtime directory.
    if (env.XDG_RUNTIME_DIR) directories.push(path.join(env.XDG_RUNTIME_DIR, 'app/com.discordapp.Discord'));
    return directories.flatMap(dir => Array.from({ length: 10 }, (_, n) => path.join(dir, `discord-ipc-${n}`)));
}

function frame(opcode, value) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(opcode, 0);
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
}

class DiscordRpc extends EventEmitter {
    constructor({ clientId, paths = ipcPaths(), connectSocket = net.createConnection, timeoutMs = 3000 } = {}) {
        super();
        this.clientId = clientId;
        this.paths = paths;
        this.connectSocket = connectSocket;
        this.timeoutMs = timeoutMs;
        this.generation = 0;
        this.socket = null;
        this.ready = false;
        this.pending = new Map();
    }

    async connect() {
        this.close();
        const generation = this.generation;
        for (const socketPath of this.paths) {
            if (generation !== this.generation) return false;
            try {
                await this.open(socketPath, generation);
                return generation === this.generation && this.ready;
            } catch {
                // Missing sockets are expected when Discord is closed or uses another slot.
            }
        }
        return false;
    }

    open(socketPath, generation) {
        return new Promise((resolve, reject) => {
            const socket = this.connectSocket({ path: socketPath });
            this.socket = socket;
            let buffer = Buffer.alloc(0);
            let connected = false;
            const timeout = setTimeout(() => socket.destroy(), this.timeoutMs);
            timeout.unref?.();
            const current = () => this.socket === socket && this.generation === generation;
            socket.on('connect', () => {
                if (!current()) return socket.destroy();
                socket.write(frame(0, { v: 1, client_id: this.clientId }));
            });
            socket.on('data', chunk => {
                if (!current()) return;
                buffer = Buffer.concat([buffer, chunk]);
                while (buffer.length >= 8) {
                    const opcode = buffer.readUInt32LE(0);
                    const length = buffer.readUInt32LE(4);
                    if (length > MAX_FRAME) return socket.destroy();
                    if (buffer.length < 8 + length) return;
                    const body = buffer.subarray(8, 8 + length);
                    buffer = buffer.subarray(8 + length);
                    if (opcode === 3) { socket.write(frame(4, body)); continue; }
                    if (opcode === 4) continue;
                    if (opcode !== 1) return socket.destroy();
                    let message;
                    try { message = JSON.parse(body.toString('utf8')); } catch { return socket.destroy(); }
                    if (!message || typeof message !== 'object') return socket.destroy();
                    if (message.cmd === 'DISPATCH' && message.evt === 'READY' && !connected) {
                        clearTimeout(timeout);
                        connected = this.ready = true;
                        resolve();
                    } else if (this.pending.has(message.nonce)) {
                        const request = this.pending.get(message.nonce);
                        this.pending.delete(message.nonce);
                        clearTimeout(request.timeout);
                        if (message.evt === 'ERROR') request.reject(new Error('Discord rejected the activity'));
                        else request.resolve();
                    }
                }
            });
            socket.on('error', () => socket.destroy());
            socket.on('close', () => {
                clearTimeout(timeout);
                reject(new Error('Discord connection closed'));
                if (!current()) return;
                this.socket = null;
                this.ready = false;
                this.rejectPending();
                if (connected) this.emit('disconnect');
            });
        });
    }

    setActivity(activity) {
        if (!this.ready || !this.socket) return Promise.reject(new Error('Discord is not connected'));
        const socket = this.socket;
        const nonce = randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => socket.destroy(), this.timeoutMs);
            timeout.unref?.();
            this.pending.set(nonce, { resolve, reject, timeout });
            socket.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce }));
        });
    }

    rejectPending() {
        for (const request of this.pending.values()) {
            clearTimeout(request.timeout);
            request.reject(new Error('Discord connection closed'));
        }
        this.pending.clear();
    }

    close() {
        this.generation++;
        const socket = this.socket;
        this.socket = null;
        this.ready = false;
        this.rejectPending();
        // Discord removes this process's presence when its IPC connection closes.
        // Reserve closing for shutdown, disabling, logout, or a failed connection.
        // Normal song/pause changes use SET_ACTIVITY on the existing connection.
        socket?.destroy();
    }
}

module.exports = { DiscordRpc, ipcPaths };
