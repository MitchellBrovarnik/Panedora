const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('./test-helpers');

function setup(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panedora-volume-config-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const electron = {
        app: { getPath: () => directory },
        safeStorage: { isEncryptionAvailable: () => false }
    };
    const reopen = () => loadModule(path.join(__dirname, '..', 'config.js'), { electron });
    reopen.file = path.join(directory, 'panedora-config.json');
    return reopen;
}
const settings = config => ({ ...config.getVolumeSettings() });

test('remembering volume is opt-in and ignores volume changes until enabled', t => {
    const reopen = setup(t);
    assert.deepEqual(settings(reopen()), { remember: false, volume: 100 });
    const config = reopen();
    config.setVolume(40);
    assert.deepEqual(settings(reopen()), { remember: false, volume: 100 });
    assert.equal(fs.existsSync(reopen.file), false, 'Nothing is written while the setting is off');
});

test('an enabled setting saves the current level and keeps following the slider across restarts', t => {
    const reopen = setup(t);
    reopen().setRememberVolume(true, 40);
    assert.deepEqual(settings(reopen()), { remember: true, volume: 40 });
    reopen().setVolume(63.6);
    assert.deepEqual(settings(reopen()), { remember: true, volume: 64 });
});

test('turning it off forgets the saved level and the next launch starts at 100%', t => {
    const reopen = setup(t);
    const config = reopen();
    config.setRememberVolume(true, 40);
    config.setRememberVolume(false, 40);
    assert.deepEqual(settings(reopen()), { remember: false, volume: 100 });
    assert.equal(JSON.parse(fs.readFileSync(reopen.file, 'utf8')).volume, null);
    reopen().setRememberVolume(true, undefined);
    assert.deepEqual(settings(reopen()), { remember: true, volume: 100 }, 'No level to restore means full volume');
});

test('a saved volume of 0 is restored as 25%, and levels are clamped to whole percentages', t => {
    const reopen = setup(t);
    reopen().setRememberVolume(true, 80);
    for (const [saved, restored] of [[0, 25], [0.4, 25], [-20, 25], [250, 100], [100, 100], [1, 1], [49.5, 50]]) {
        reopen().setVolume(saved);
        assert.equal(reopen().getVolumeSettings().volume, restored, `saved ${saved}`);
    }
});

test('invalid levels are ignored on save and fall back to 100% when the file holds one', t => {
    const reopen = setup(t);
    reopen().setRememberVolume(true, 70);
    for (const value of ['50', null, undefined, NaN, Infinity, {}, []]) reopen().setVolume(value);
    assert.equal(reopen().getVolumeSettings().volume, 70);
    const stored = JSON.parse(fs.readFileSync(reopen.file, 'utf8'));
    for (const bad of ['abc', null, {}, NaN, [], true]) {
        fs.writeFileSync(reopen.file, JSON.stringify({ ...stored, volume: bad }));
        assert.deepEqual(settings(reopen()), { remember: true, volume: 100 }, JSON.stringify(bad));
    }
    // Only a literal true enables the setting.
    fs.writeFileSync(reopen.file, JSON.stringify({ rememberVolume: 'true', volume: 30 }));
    assert.deepEqual(settings(reopen()), { remember: false, volume: 100 });
    reopen().setRememberVolume('true', 30);
    assert.equal(reopen().getVolumeSettings().remember, false);
});

test('the volume preference lives with the other installation settings and survives sign-out', t => {
    const reopen = setup(t);
    const config = reopen();
    config.setCredentials('listener@example.invalid', 'fixture-password');
    config.setRememberVolume(true, 35);
    config.clearAll();
    assert.deepEqual(settings(reopen()), { remember: true, volume: 35 });
    const stored = JSON.parse(fs.readFileSync(reopen.file, 'utf8'));
    assert.equal(stored.rememberVolume, true);
    assert.equal(stored.volume, 35);
});

test('the legacy miniplayer is opt-in, strictly boolean, and survives sign-out', t => {
    const reopen = setup(t);
    assert.equal(reopen().getLegacyMiniplayer(), false);
    const config = reopen();
    config.setLegacyMiniplayer(true);
    assert.equal(reopen().getLegacyMiniplayer(), true);
    config.clearAll();
    assert.equal(reopen().getLegacyMiniplayer(), true);
    config.setLegacyMiniplayer('true');
    assert.equal(reopen().getLegacyMiniplayer(), false, 'Only a literal true enables it');
    config.setLegacyMiniplayer(true);
    config.setLegacyMiniplayer(false);
    assert.equal(reopen().getLegacyMiniplayer(), false);
    assert.equal(JSON.parse(fs.readFileSync(reopen.file, 'utf8')).legacyMiniplayer, false);
    // Independent of the volume preference stored beside it.
    reopen().setRememberVolume(true, 40);
    reopen().setLegacyMiniplayer(true);
    assert.deepEqual(settings(reopen()), { remember: true, volume: 40 });
    assert.equal(reopen().getLegacyMiniplayer(), true);
});

test('the classic mini player\u2019s position is remembered, validated and independent of other settings', t => {
    const reopen = setup(t);
    assert.equal(reopen().getClassicMiniBounds(), null);
    const bounds = { x: 120.4, y: -30, width: 301.6, height: 640 };
    reopen().setClassicMiniBounds(bounds);
    assert.deepEqual({ ...reopen().getClassicMiniBounds() }, { x: 120, y: -30, width: 302, height: 640 });
    reopen().clearAll();
    assert.deepEqual({ ...reopen().getClassicMiniBounds() }, { x: 120, y: -30, width: 302, height: 640 }, 'Survives sign-out');
    for (const bad of [null, undefined, 'x', {}, { x: 1, y: 2, width: 0, height: 5 }, { x: 1, y: 2, width: 5, height: -1 },
        { x: NaN, y: 2, width: 5, height: 5 }, { x: '1', y: 2, width: 5, height: 5 }, { x: 1, y: 2, width: Infinity, height: 5 }]) {
        reopen().setClassicMiniBounds(bad);
        assert.equal(reopen().getClassicMiniBounds(), null, JSON.stringify(bad));
    }
    reopen().setClassicMiniBounds(bounds);
    fs.writeFileSync(reopen.file, JSON.stringify({ classicMiniBounds: { x: 1, y: 2, width: 'wide', height: 5 } }));
    assert.equal(reopen().getClassicMiniBounds(), null, 'A corrupt stored value is ignored');
});
