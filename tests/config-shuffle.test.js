const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('./test-helpers');

function setup(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panedora-shuffle-config-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const electron = {
        app: { getPath: () => directory },
        safeStorage: { isEncryptionAvailable: () => false }
    };
    return () => loadModule(path.join(__dirname, '..', 'config.js'), { electron });
}

test('update snooze survives app restart and account changes without storing account details', t => {
    const reopen = setup(t);
    const first = reopen();
    assert.equal(first.getUpdateSnooze(), null);
    const snooze = { version: '1.2.0', until: 86400000 };
    first.setUpdateSnooze(snooze);
    first.setCredentials('listener@example.invalid', 'fixture-password');
    first.clearAll();
    assert.deepEqual({ ...reopen().getUpdateSnooze() }, snooze);
});

test('Discord sharing is opt-in and its local preference persists across restarts and sign-out', t => {
    const reopen = setup(t);
    assert.equal(reopen().getDiscordEnabled(), false);
    const config = reopen();
    config.setDiscordEnabled(true);
    assert.equal(reopen().getDiscordEnabled(), true);
    config.clearAll();
    assert.equal(reopen().getDiscordEnabled(), true);
    config.setDiscordEnabled(false);
    assert.equal(reopen().getDiscordEnabled(), false);
    config.setDiscordEnabled('true');
    assert.equal(reopen().getDiscordEnabled(), false);
});

test('remembered Shuffle is restored from disk after the config module restarts', t => {
    const reopen = setup(t);
    const first = reopen();
    first.setCredentials('Listener@Example.invalid', 'fixture-password');
    first.rememberShuffle({ stationId: 'shuffle-123', lastPlayed: '2026-01-01T12:00:00.000Z' });
    const restarted = reopen();
    assert.equal(restarted.getRememberedShuffle().stationId, 'shuffle-123');
    assert.equal(restarted.getRememberedShuffle().isShuffle, true);
    assert.equal(restarted.getRememberedShuffle().lastPlayed, '2026-01-01T12:00:00.000Z');
    restarted.setCredentials('listener@example.invalid', 'new-fixture-password');
    assert.equal(restarted.getRememberedShuffle().stationId, 'shuffle-123');
});

test('remembered Shuffle belongs to its account and is cleared on logout', t => {
    const reopen = setup(t);
    const config = reopen();
    config.rememberShuffle({ stationId: 'no-account' });
    assert.equal(config.getRememberedShuffle(), null);
    config.setCredentials('first@example.invalid', 'fixture-password');
    config.rememberShuffle({ stationId: 'first-shuffle' });
    config.setCredentials('second@example.invalid', 'fixture-password');
    assert.equal(config.getRememberedShuffle(), null);
    config.rememberShuffle({ stationId: 'second-shuffle' });
    assert.equal(reopen().getRememberedShuffle().stationId, 'second-shuffle');
    config.clearAll();
    const afterLogout = reopen();
    afterLogout.setCredentials('second@example.invalid', 'fixture-password');
    assert.equal(afterLogout.getRememberedShuffle(), null);
});

test('station recency survives restart, stays account-specific and forgets removed stations', t => {
    const reopen = setup(t);
    const first = reopen();
    first.setCredentials('Listener@Example.invalid', 'fixture-password');
    first.rememberStationPlayed('station-1', '2026-10-07T20:00:00.000Z');
    first.rememberStationPlayed('station-2', '2026-10-07T21:00:00.000Z');
    const restarted = reopen();
    assert.equal(restarted.getStationRecency()['station-2'], '2026-10-07T21:00:00.000Z');
    restarted.setCredentials('listener@example.invalid', 'changed-password');
    assert.equal(Object.keys(restarted.getStationRecency()).length, 2);
    restarted.forgetStationRecency('station-2');
    assert.equal(reopen().getStationRecency()['station-2'], undefined);
    assert.ok(reopen().getStationRecency()['station-1']);
    restarted.setCredentials('other@example.invalid', 'fixture-password');
    assert.equal(Object.keys(restarted.getStationRecency()).length, 0);
    restarted.rememberStationPlayed('other-station', '2026-10-07T22:00:00.000Z');
    assert.deepEqual(Object.keys(reopen().getStationRecency()), ['other-station']);
    restarted.clearAll();
    restarted.setCredentials('other@example.invalid', 'fixture-password');
    assert.equal(Object.keys(reopen().getStationRecency()).length, 0);
});
