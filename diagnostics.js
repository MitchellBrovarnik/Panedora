'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SESSION_FILE = /^\d{13}-[\da-f-]{36}\.json$/;
const MAX_SESSIONS = 4;
const MAX_EVENTS = 60;
const MAX_FILE_BYTES = 32 * 1024;

function isRunning(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

class Diagnostics {
    constructor(directory, environment) {
        this.directory = directory;
        this.file = path.join(directory, `${Date.now()}-${randomUUID()}.json`);
        this.session = {
            pid: process.pid, ...environment, startedAt: new Date().toISOString(),
            closedAt: null, events: []
        };
        this.previousInterrupted = false;
        try {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            const previous = this.files().map(file => this.read(file))
                .find(session => session && (session.closedAt || !isRunning(session.pid)));
            this.previousInterrupted = !!previous && !previous.closedAt;
            if (this.save()) {
                const olderFiles = this.files().filter(file => file !== this.file).slice(MAX_SESSIONS - 1);
                for (const file of olderFiles) {
                    const session = this.read(file);
                    if (session && (session.closedAt || !isRunning(session.pid))) fs.rmSync(file, { force: true });
                }
            }
        } catch {
            // Diagnostics must never prevent startup.
        }
    }

    files() {
        return fs.readdirSync(this.directory).filter(name => SESSION_FILE.test(name))
            .sort().reverse().map(name => path.join(this.directory, name));
    }

    read(file) {
        try {
            if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return null;
        }
    }

    save() {
        // Replace the previous snapshot only after the new one has been written.
        // A process exit during a write leaves the earlier snapshot readable.
        const temporary = this.file + '.tmp';
        try {
            fs.writeFileSync(temporary, JSON.stringify(this.session), { mode: 0o600 });
            fs.renameSync(temporary, this.file);
            return true;
        } catch {
            return false;
        }
    }

    record(event, details) {
        this.session.events.push({ at: new Date().toISOString(), event, ...details });
        if (this.session.events.length > MAX_EVENTS) this.session.events.shift();
        this.save();
    }

    close() {
        this.session.closedAt = new Date().toISOString();
        this.save();
    }

    report() {
        try {
            const files = this.files();
            const recent = files.filter(file => file !== this.file).slice(0, MAX_SESSIONS - 1).reverse();
            if (files.includes(this.file)) recent.push(this.file);
            const sessions = recent.flatMap(file => {
                const session = this.read(file);
                if (!session) return [];
                const { pid, ...report } = session;
                return [report];
            });
            return sessions.length ? {
                previousInterrupted: this.previousInterrupted,
                text: JSON.stringify({ format: 'Panedora diagnostics', sessions }, null, 2)
            } : null;
        } catch {
            return null;
        }
    }
}

module.exports = { Diagnostics };
