// Local protocol fixture only: no Discord account or external service is contacted.
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function encode(opcode, value) {
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const bytes = Buffer.alloc(payload.length + 8);
    bytes.writeUInt32LE(opcode, 0);
    bytes.writeUInt32LE(payload.length, 4);
    payload.copy(bytes, 8);
    return bytes;
}

async function createDiscordFixture({ splitReady = false, acknowledge = true } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panedora-discord-'));
    const socketPath = process.platform === 'win32'
        ? `\\\\?\\pipe\\panedora-discord-test-${process.pid}-${path.basename(directory)}` : path.join(directory, 'discord-ipc-0');
    const connections = [];
    const server = net.createServer(socket => {
        const connection = { socket, messages: [], activity: null, closed: false };
        connections.push(connection);
        let bytes = Buffer.alloc(0);
        socket.on('error', () => {});
        socket.on('close', () => { connection.closed = true; connection.activity = null; });
        socket.on('data', chunk => {
            bytes = Buffer.concat([bytes, chunk]);
            while (bytes.length >= 8 && bytes.length >= 8 + bytes.readUInt32LE(4)) {
                const opcode = bytes.readUInt32LE(0);
                const body = bytes.subarray(8, 8 + bytes.readUInt32LE(4));
                bytes = bytes.subarray(8 + body.length);
                if (opcode === 4) { connection.pong = Buffer.from(body); continue; }
                const message = JSON.parse(body.toString());
                connection.messages.push({ opcode, ...message });
                if (opcode === 0) {
                    const ready = encode(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } });
                    if (splitReady) {
                        socket.write(ready.subarray(0, 5));
                        setImmediate(() => { if (!socket.destroyed) socket.write(ready.subarray(5)); });
                    } else socket.write(ready);
                } else if (message.cmd === 'SET_ACTIVITY') {
                    connection.activity = message.args.activity;
                    if (acknowledge) socket.write(encode(1, { cmd: 'SET_ACTIVITY', nonce: message.nonce, data: {} }));
                }
            }
        });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    return {
        socketPath, connections,
        get active() { return connections.findLast(connection => !connection.closed)?.activity || null; },
        async close() {
            for (const connection of connections) connection.socket.destroy();
            await new Promise(resolve => server.close(resolve));
            fs.rmSync(directory, { recursive: true, force: true });
        }
    };
}

module.exports = { createDiscordFixture, encode };
