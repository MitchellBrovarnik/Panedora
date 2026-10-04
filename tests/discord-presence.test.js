const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DiscordPresence } = require('../discord-presence');
const { DiscordRpc, ipcPaths } = require('../discord-rpc');
const { createDiscordFixture, encode } = require('./discord-fixture');

const tick = () => new Promise(resolve => setImmediate(resolve));
const clientId = '123456789012345678';
const player = (token = 'track-1', extra = {}) => ({ trackToken: token, playbackGeneration: 1,
    audioURL: 'https://fixture.invalid/SECRET-AUDIO', track: 'Thunder', artist: 'Imagine Dragons',
    album: 'Evolve', coverArt: 'https://cont-1.p-cdn.com/images/public/cover.jpg', duration: 180,
    isPlaying: true, authToken: 'SECRET-AUTH', ...extra });
const report = (position = 12, extra = {}) => ({ trackToken: 'track-1', playbackGeneration: 1,
    playing: true, position, duration: 180, ...extra });

function setup(t, options = {}) {
    let now = 1700000000000;
    const timers = new Set();
    const statuses = [];
    const rpc = new class extends EventEmitter {
        ready = false; connects = 0; updates = []; active = null;
        async connect() { this.connects++; this.ready = options.available !== false; return this.ready; }
        async setActivity(activity) {
            if (this.rejectUpdate) throw new Error('Rejected');
            this.updates.push(activity); this.active = activity;
            if (this.hold) await this.hold;
        }
        close() { this.ready = false; this.active = null; }
    }();
    const presence = new DiscordPresence({ clientId, rpc, ...options,
        now: () => now, onStatus: status => statuses.push(status),
        setTimer: (fn, delay) => { const timer = { fn, at: now + delay }; timers.add(timer); return timer; },
        clearTimer: timer => timers.delete(timer) });
    t.after(() => presence.dispose());
    presence.setPlayerState(player());
    const advance = async ms => {
        const end = now + ms;
        while (true) {
            const next = [...timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!next) break;
            now = next.at; timers.delete(next); next.fn(); await tick();
        }
        now = end; await tick();
    };
    return { presence, rpc, timers, statuses, advance, get now() { return now; } };
}

test('sharing defaults off and an absent or invalid Application ID never connects', async t => {
    for (const options of [{}, { enabled: true, clientId: '' }, { enabled: true, clientId: 'a-token' }]) {
        const s = setup(t, options);
        s.presence.reportPlayback(report()); await tick();
        assert.equal(s.rpc.connects, 0);
        assert.equal(s.rpc.updates.length, 0);
    }
});

test('publish only actual playback, with public metadata and millisecond timestamps', async t => {
    const s = setup(t, { enabled: true });
    await tick(); assert.equal(s.rpc.connects, 0, 'A queued/loading track is not listening');
    s.presence.reportPlayback(report()); await tick();
    assert.deepEqual(s.rpc.active, { type: 2, details: 'Thunder', state: 'Imagine Dragons',
        assets: { large_image: 'https://cont-1.p-cdn.com/images/public/cover.jpg', large_text: 'Evolve' },
        timestamps: { start: s.now - 12000, end: s.now + 168000 } });
    assert.doesNotMatch(JSON.stringify(s.rpc.active), /SECRET|track-1|audioURL|authToken|playbackGeneration/);
    assert.equal(s.presence.getStatus().status, 'connected');
});

test('ignore old songs/sessions and invalid IPC reports; renderer metadata cannot override main', async t => {
    const s = setup(t, { enabled: true });
    for (const bad of [report(12, { trackToken: 'old' }), report(12, { playbackGeneration: 0 }),
        report(NaN), report(-1), report(Infinity), report(1, { duration: -1 }), report(1, { playing: 'true' }),
        report(1, { paused: 'yes' }), report(1, { paused: true }), null]) {
        assert.equal(s.presence.reportPlayback(bad), false);
    }
    await tick(); assert.equal(s.rpc.connects, 0);
    s.presence.reportPlayback(report(12, { track: 'Spoofed', coverArt: 'https://other.invalid' })); await tick();
    assert.equal(s.rpc.active.details, 'Thunder');
});

test('normal progress is deduplicated; rapid seeks and skips publish only the latest position/song', async t => {
    const s = setup(t, { enabled: true });
    s.presence.reportPlayback(report()); await tick();
    await s.advance(15000); s.presence.reportPlayback(report(27)); await tick();
    assert.equal(s.rpc.updates.length, 1);
    s.presence.reportPlayback(report(70)); await tick();
    s.presence.reportPlayback(report(80));
    s.presence.setPlayerState(player('track-2', { track: 'Believer' }));
    s.presence.reportPlayback(report(0, { trackToken: 'track-2' })); await tick();
    assert.equal(s.rpc.active.details, 'Thunder', 'Keep the connection while coalescing the newest song');
    await s.advance(5000);
    assert.equal(s.rpc.updates.length, 3);
    assert.equal(s.rpc.active.details, 'Believer');
    assert.equal(s.rpc.active.timestamps.start, s.now - 5000);
});

test('consecutive skips keep one Discord connection and eventually publish the newest song', async t => {
    const s = setup(t, { enabled: true });
    s.presence.reportPlayback(report()); await tick();
    await s.advance(1000);
    s.presence.setPlayerState(player('track-2', { track: 'Second' }));
    s.presence.reportPlayback(report(0, { trackToken: 'track-2' })); await tick();
    await s.advance(1000);
    s.presence.setPlayerState(player('track-3', { track: 'Third' }));
    s.presence.reportPlayback(report(0, { trackToken: 'track-3' })); await tick();
    assert.equal(s.rpc.connects, 1, 'Skipping must not close/reopen IPC');
    await s.advance(3000);
    assert.equal(s.rpc.active.details, 'Third');
    assert.equal(s.rpc.updates.length, 2, 'The intermediate song is coalesced');
});

test('takeover, logout, renderer loss and disabling clear presence immediately', async t => {
    for (const clear of [s => s.presence.setPlayerState(player('track-1', { streamBlocked: true })),
        s => s.presence.setPlayerState(null), s => s.presence.invalidatePlayback(), s => s.presence.setEnabled(false)]) {
        const s = setup(t, { enabled: true });
        s.presence.reportPlayback(report()); await tick();
        assert.ok(s.rpc.active);
        await clear(s); await tick();
        assert.equal(s.rpc.active, null);
    }
});

test('pause retains metadata and omits song timestamps; resume uses the actual position', async t => {
    const s = setup(t);
    s.presence.reportPlayback(report());
    s.presence.setEnabled(true); await tick(); assert.ok(s.rpc.active);
    s.presence.reportPlayback(report(14, { playing: false, paused: true }));
    s.presence.setPlayerState(player('track-1', { isPlaying: false }));
    await s.advance(5000);
    assert.equal(s.rpc.active.details, 'Thunder');
    assert.equal(s.rpc.active.state, 'Paused · Imagine Dragons');
    assert.equal(s.rpc.active.assets.large_text, 'Evolve');
    assert.equal(s.rpc.active.timestamps, undefined);
    await s.advance(300000);
    assert.equal(s.rpc.active.state, 'Paused · Imagine Dragons', 'Pausing does not expire after 45 seconds');
    assert.equal(s.rpc.updates.length, 2, 'Paused presence makes no periodic Discord writes');
    assert.equal(s.rpc.connects, 1);
    s.presence.setPlayerState(player());
    s.presence.reportPlayback(report(14)); await tick();
    assert.equal(s.rpc.active.timestamps.start, s.now - 14000);
    assert.equal(s.rpc.active.state, 'Imagine Dragons');
    s.presence.setEnabled(false);
    assert.equal(s.rpc.active, null);
    assert.equal(s.presence.getStatus().status, 'disabled');
});

test('long buffering, loading and a missing heartbeat clear through the existing connection', async t => {
    for (const stall of [s => s.presence.reportPlayback(report(12, { playing: false })),
        s => s.presence.setPlayerState(player('track-1', { stationLoading: true })), s => s.advance(45000)]) {
        const s = setup(t, { enabled: true });
        s.presence.reportPlayback(report()); await tick();
        await stall(s); await s.advance(5000);
        assert.equal(s.rpc.active, null);
        assert.equal(s.rpc.ready, true);
        s.presence.setPlayerState(player());
        s.presence.reportPlayback(report(20)); await s.advance(5000);
        assert.equal(s.rpc.active.details, 'Thunder');
        assert.equal(s.rpc.connects, 1);
    }
});

test('brief buffering does not spend an update slot clearing the song', async t => {
    const s = setup(t, { enabled: true });
    s.presence.reportPlayback(report()); await tick();
    await s.advance(15000);
    s.presence.reportPlayback(report(27, { playing: false }));
    await s.advance(500);
    s.presence.reportPlayback(report(27)); await tick();
    assert.ok(s.rpc.updates.every(Boolean), 'No intermediate clear consumes an update slot');
    assert.equal(s.rpc.connects, 1);
});

test('a delayed acknowledgement cannot lose the latest skip or a pending clear', async t => {
    const s = setup(t, { enabled: true });
    let finish;
    s.rpc.hold = new Promise(resolve => { finish = resolve; });
    s.presence.reportPlayback(report()); await tick();
    s.presence.setPlayerState(player('track-2', { track: 'Second' }));
    s.presence.reportPlayback(report(0, { trackToken: 'track-2' }));
    s.presence.setPlayerState(player('track-3', { track: 'Third' }));
    s.presence.reportPlayback(report(0, { trackToken: 'track-3' }));
    s.rpc.hold = null; finish(); await tick();
    await s.advance(5000);
    assert.equal(s.rpc.active.details, 'Third');
    assert.equal(s.rpc.connects, 1);
    s.presence.reportPlayback(report(5, { trackToken: 'track-3', playing: false }));
    await s.advance(5000);
    assert.equal(s.rpc.active, null);
});

test('Discord absence/restart retries quietly and disabling cancels connection retries', async t => {
    const s = setup(t, { enabled: true, available: false });
    s.presence.reportPlayback(report()); await tick();
    assert.equal(s.presence.getStatus().status, 'unavailable');
    await s.advance(15000); s.presence.reportPlayback(report(27));
    await s.advance(15000); s.presence.reportPlayback(report(42));
    assert.equal(s.rpc.connects, 2);
    s.rpc.connect = async () => { s.rpc.connects++; s.rpc.ready = true; return true; };
    s.presence.setEnabled(false); s.presence.setEnabled(true); await tick();
    assert.ok(s.rpc.active);
    s.rpc.ready = false; s.rpc.emit('disconnect');
    s.presence.setEnabled(false);
    const count = s.rpc.connects;
    await s.advance(300000);
    assert.equal(s.rpc.connects, count);
});

test('late connection/acknowledgement cannot resurrect disabled or signed-out activity', async t => {
    const s = setup(t, { enabled: true });
    let finish;
    s.rpc.hold = new Promise(resolve => { finish = resolve; });
    s.presence.reportPlayback(report()); await tick();
    s.presence.setEnabled(false); finish(); await tick();
    assert.equal(s.rpc.active, null);
    assert.equal(s.presence.getStatus().status, 'disabled');
    s.rpc.hold = null;
    s.presence.setEnabled(true);
    s.presence.setPlayerState(null); await tick();
    assert.equal(s.rpc.active, null);
    assert.equal(s.presence.getStatus().status, 'idle');
});

test('Discord errors stay isolated and unsafe artwork URLs are excluded', async t => {
    const s = setup(t, { enabled: true });
    s.rpc.rejectUpdate = true;
    s.presence.reportPlayback(report()); await tick();
    assert.equal(s.presence.getStatus().status, 'error');
    assert.equal(s.rpc.active, null);
    s.presence.setEnabled(false); s.rpc.rejectUpdate = false;
    s.presence.setPlayerState(player('track-1', { coverArt: 'https://user:secret@example.invalid/a.jpg' }));
    s.presence.reportPlayback(report()); s.presence.setEnabled(true);
    await s.advance(5000);
    assert.equal(s.rpc.active.assets, undefined);
});

test('IPC paths cover Windows, macOS/Linux and Flatpak without a network port', () => {
    assert.equal(ipcPaths('win32', {})[0], '\\\\?\\pipe\\discord-ipc-0');
    assert.equal(ipcPaths('win32', {}).length, 10);
    const paths = ipcPaths('linux', { XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: '/custom-tmp' });
    assert.equal(paths[0], '/run/user/1000/discord-ipc-0');
    assert.ok(paths.includes('/custom-tmp/discord-ipc-9'));
    assert.ok(paths.includes('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'));
    assert.equal(ipcPaths('darwin', { TMPDIR: '/var/folders/tmp' })[0], '/var/folders/tmp/discord-ipc-0');
});

test('real IPC socket handles fragmented READY, coalesced ping, activity acknowledgement and close', async t => {
    const server = await createDiscordFixture({ splitReady: true });
    const rpc = new DiscordRpc({ clientId, paths: [server.socketPath + '-missing', server.socketPath] });
    t.after(async () => { rpc.close(); await server.close(); });
    assert.equal(await rpc.connect(), true);
    const connection = server.connections[0];
    assert.deepEqual(connection.messages[0], { opcode: 0, v: 1, client_id: clientId });
    const ping = Buffer.from([0, 255, 10]);
    connection.socket.write(Buffer.concat([encode(3, ping), encode(3, ping)]));
    await rpc.setActivity({ type: 2, details: 'Thunder', state: 'Imagine Dragons' });
    assert.deepEqual(connection.pong, ping);
    const command = connection.messages[1];
    assert.equal(command.cmd, 'SET_ACTIVITY'); assert.equal(command.args.pid, process.pid);
    assert.equal(server.active.details, 'Thunder');
    await rpc.setActivity(null);
    assert.equal(server.active, null);
    assert.equal(rpc.ready, true, 'Clearing activity does not close the connection');
    const disconnected = new Promise(resolve => rpc.once('disconnect', resolve));
    connection.socket.destroy(); await disconnected;
    assert.equal(rpc.ready, false);
});

test('real IPC rejects oversized frames and times out unanswered commands', async t => {
    for (const malformed of [true, false]) {
        const server = await createDiscordFixture({ acknowledge: false });
        const rpc = new DiscordRpc({ clientId, paths: [server.socketPath], timeoutMs: 100 });
        t.after(async () => { rpc.close(); await server.close(); });
        assert.equal(await rpc.connect(), true);
        const pending = rpc.setActivity({ type: 2, details: 'Test' });
        if (malformed) {
            const oversized = Buffer.alloc(8); oversized.writeUInt32LE(1); oversized.writeUInt32LE(1000000, 4);
            server.connections[0].socket.write(oversized);
        }
        await assert.rejects(pending, /closed/);
        assert.equal(rpc.ready, false);
    }
});
