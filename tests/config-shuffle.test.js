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
