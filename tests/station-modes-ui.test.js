const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const tick = () => new Promise(resolve => setImmediate(resolve));
function modes(currentModeId = 0, extra = {}) {
    return { status: 'ready', available: true, currentModeId, changing: false, modes: [
        { id: 0, name: 'My Station', description: 'Your station.', available: true },
        { id: 1091989, name: 'Energy Boost', description: 'More energy <without markup>.', available: true },
        { id: 5, name: 'Artist Only', available: false, premiumOnly: true },
        { id: 987654, name: 'Curated <Mix>', available: true }
    ], ...extra };
}

function setup(t) {
    const root = path.join(__dirname, '..');
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
        url: 'https://panedora.test/', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    const calls = [];
    const player = {
        getStationModes: async stationId => {
            calls.push(['get', stationId]);
            window.testUI.update({ stationModes: modes() });
            return { success: true };
        },
        resolveStreamConflict: async (id, takeOver) => {
            calls.push(['takeover', id, takeOver]);
            window.testUI.update({ streamPrompt: null });
            return { success: true };
        },
        setStationMode: async (stationId, modeId) => {
            calls.push(['set', stationId, modeId]);
            window.testUI.update({ stationModes: modes(modeId) });
            return { success: true };
        }
    };
    window.api = { player, window: {}, content: {} };
    window.eval(fs.readFileSync(path.join(root, 'components.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(root, 'renderer.js'), 'utf8') + `
        document.removeEventListener('DOMContentLoaded', init);
        window.testUI = { state: AppState, update: updatePlayerUI, render: renderPage, renderStations: renderStationsList };
        initEventListeners();
    `);
    const ui = window.testUI;
    ui.state.isLoggedIn = true;
    ui.state.isLoading = false;
    ui.update({
        playbackGeneration: 1,
        stationId: 'station-1', stationName: 'Fixture Radio', track: 'Current Song',
        trackToken: 'current', feedback: 'thumbUp', isPlaying: true,
        stationModes: { status: 'idle' }
    });
    ui.render('home');
    t.after(() => window.close());
    const node = id => window.document.getElementById(id);
    const open = () => node('now-playing-art').click();
    const select = value => {
        node('np-mode-select').click();
        node('np-mode-option-' + value).click();
    };
    return { window, ui, player, calls, node, open, select };
}

test('artwork opens tuning above history with only available API options and escaped names', async t => {
    const s = setup(t);
    assert.equal(s.node('np-mode-select'), null);
    assert.equal(s.calls.length, 0);
    s.open();
    await tick();
    assert.deepEqual(s.calls, [['get', 'station-1']]);
    assert.equal(s.node('np-mode-select').value, '0');
    assert.deepEqual(Array.from(s.node('np-mode-menu').children, option => option.dataset.modeId), ['0', '1091989', '987654']);
    assert.match(s.node('np-mode-option-987654').textContent, /Curated <Mix>/);
    assert.match(s.node('np-mode-status').textContent, /starts a new song/);
    assert.equal(s.window.document.querySelector('#np-station-tuning mix'), null);
    assert.equal(s.node('np-station-tuning').nextElementSibling.className, 'np-history');
    assert.equal(s.node('np-thumbup').classList.contains('liked'), true);
    const selector = s.node('np-mode-select');
    selector.focus();
    s.ui.update({ isPlaying: false });
    assert.equal(s.node('np-mode-select'), selector, 'Partial playback updates must preserve the selector and its focus');
    assert.equal(s.window.document.activeElement, selector);
    s.node('np-back-btn').click();
    assert.equal(s.node('np-mode-select'), null);
});

test('the selector keeps the confirmed value while waiting and submits the returned ID', async t => {
    const s = setup(t);
    s.open();
    await tick();
    let finish;
    s.player.setStationMode = async (stationId, modeId) => {
        s.calls.push(['set', stationId, modeId]);
        s.ui.update({ stationModes: modes(0, { changing: true }) });
        return new Promise(resolve => { finish = resolve; });
    };
    s.select(1091989);
    assert.deepEqual(s.calls[1], ['set', 'station-1', 1091989]);
    assert.equal(s.node('np-mode-select').value, '0');
    assert.equal(s.node('np-mode-select').disabled, true);
    assert.match(s.node('np-mode-status').textContent, /Changing/);
    s.ui.update({ stationModes: modes(1091989) });
    finish({ success: true });
    await tick();
    assert.equal(s.node('np-mode-select').value, '1091989');
    assert.equal(s.node('np-mode-select').disabled, false);
    assert.equal(s.node('np-mode-description').textContent, 'More energy <without markup>.');
    assert.equal(s.node('np-mode-description').childElementCount, 0);
    assert.equal(s.ui.state.playerState.trackToken, 'current');
    assert.equal(s.ui.state.playerState.feedback, 'thumbUp');
});

test('silent rejection retains the actual mode and IPC failure restores an enabled selector', async t => {
    const s = setup(t);
    s.open();
    await tick();
    s.player.setStationMode = async () => {
        s.ui.update({ stationModes: modes(0, { error: 'Pandora did not enable that mode.' }) });
        return { success: false };
    };
    s.select(1091989);
    await tick();
    assert.equal(s.node('np-mode-select').value, '0');
    assert.match(s.node('np-mode-status').textContent, /did not enable/);
    assert.equal(s.node('np-mode-select').disabled, false);
    s.player.setStationMode = async () => { throw new Error('IPC closed'); };
    s.select(1091989);
    await tick();
    assert.equal(s.node('np-mode-select').disabled, false);
    assert.equal(s.node('np-mode-select').value, '0');
});

test('mode loading errors can be retried and stations without modes get no invented choices', async t => {
    const s = setup(t);
    s.player.getStationModes = async () => {
        s.ui.update({ stationModes: { status: 'error', error: 'Could not load modes.' } });
    };
    s.open();
    await tick();
    assert.equal(s.node('np-mode-select').disabled, true);
    s.player.getStationModes = async () => s.ui.update({ stationModes: modes() });
    s.node('np-mode-retry').click();
    await tick();
    assert.equal(s.node('np-mode-select').disabled, false);
    assert.equal(s.node('np-mode-retry'), null);
    s.ui.update({ stationModes: modes(null, { available: false, modes: [] }) });
    assert.equal(s.node('np-station-tuning').hidden, true);
    assert.equal(s.node('np-mode-select'), null);
});

test('Artist Only appears only when the API offers it and marks it available, even if premium-only', async t => {
    const s = setup(t);
    s.open();
    await tick();
    assert.equal(s.window.document.querySelector('#np-mode-option-5'), null);
    const eligible = modes();
    eligible.modes.find(mode => mode.id === 5).available = true;
    s.ui.update({ stationModes: eligible });
    assert.equal(s.window.document.querySelector('#np-mode-option-5').disabled, false);
    s.select(5);
    await tick();
    assert.deepEqual(s.calls.at(-1), ['set', 'station-1', 5]);
    s.ui.update({ stationModes: modes(0, { modes: eligible.modes.filter(mode => mode.id !== 5) }) });
    assert.equal(s.window.document.querySelector('#np-mode-option-5'), null);
});

test('Shuffle hides tuning and sends no mode requests; switching back restores eligible options', async t => {
    const s = setup(t);
    s.ui.update({ isShuffle: true });
    s.open();
    await tick();
    assert.equal(s.node('np-station-tuning').hidden, true);
    assert.equal(s.node('np-mode-select'), null);
    assert.equal(s.calls.length, 0);
    s.ui.update({ isShuffle: false, stationId: 'station-2', stationModes: { status: 'idle' } });
    await tick();
    assert.deepEqual(s.calls, [['get', 'station-2']]);
    assert.equal(s.node('np-station-tuning').hidden, false);
    assert.equal(s.node('np-mode-select').value, '0');
    s.ui.update({ isShuffle: true, stationId: 'shuffle', stationModes: { status: 'idle' } });
    assert.equal(s.node('np-mode-select'), null, 'Previously rendered controls are removed');
    assert.equal(s.calls.length, 1);
});

test('a station whose modes are all unavailable hides the tuning panel', async t => {
    const s = setup(t);
    s.player.getStationModes = async () => s.ui.update({ stationModes: modes(null, {
        modes: [{ id: 5, name: 'Artist Only', available: false, premiumOnly: true }]
    }) });
    s.open();
    await tick();
    assert.equal(s.node('np-station-tuning').hidden, true);
    assert.equal(s.node('np-mode-select'), null);
});

test('a stale request failure cannot replace another station’s modes; conflicts disable tuning', async t => {
    const s = setup(t);
    let reject;
    s.player.getStationModes = async () => new Promise((resolve, fail) => { reject = fail; });
    s.open();
    s.player.getStationModes = async () => s.ui.update({ stationModes: modes(1091989) });
    s.ui.update({ stationId: 'station-2', stationName: 'Other Radio', stationModes: { status: 'idle' } });
    await tick();
    reject(new Error('Old station request'));
    await tick();
    assert.equal(s.node('np-mode-select').value, '1091989');
    assert.equal(s.window.document.querySelector('.station-tuning-name').textContent, 'Other Radio');
    s.ui.update({ streamBlocked: true });
    assert.equal(s.node('np-mode-select').disabled, true);
    assert.match(s.node('np-mode-status').textContent, /Resume playback here/);
});

test('restarting the same station loads fresh modes without waiting for an old request', async t => {
    const s = setup(t);
    let rejectOld;
    let reads = 0;
    s.player.getStationModes = async () => {
        reads++;
        if (reads === 1) return new Promise((resolve, reject) => { rejectOld = reject; });
        s.ui.update({ stationModes: modes(1091989) });
    };
    s.open();
    s.ui.update({ playbackGeneration: 2, stationModes: { status: 'idle' } });
    await tick();
    const readsBeforeOldFinished = reads;
    rejectOld(new Error('Obsolete station session'));
    await tick();
    assert.equal(readsBeforeOldFinished, 2, 'The new station session must not be blocked by an old mode request');
    assert.equal(s.node('np-mode-select').value, '1091989');
    assert.equal(s.node('np-mode-select').disabled, false);
    assert.equal(s.node('np-mode-retry'), null);
});

test('the custom mode menu supports keyboard navigation, dismissal and stable focus', async t => {
    const s = setup(t);
    s.open();
    await tick();
    const key = name => s.window.document.activeElement.dispatchEvent(new s.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    s.node('np-mode-select').focus();
    key('ArrowDown');
    assert.equal(s.node('np-mode-select').getAttribute('aria-expanded'), 'true');
    assert.equal(s.window.document.activeElement.id, 'np-mode-option-0');
    key('ArrowDown');
    assert.equal(s.window.document.activeElement.id, 'np-mode-option-1091989');
    s.ui.update({ isPlaying: false });
    assert.equal(s.window.document.activeElement.id, 'np-mode-option-1091989');
    key('End');
    assert.equal(s.window.document.activeElement.id, 'np-mode-option-987654');
    key('Home');
    key('Escape');
    assert.equal(s.node('np-mode-menu').hidden, true);
    assert.equal(s.window.document.activeElement.id, 'np-mode-select');
    assert.equal(s.calls.some(call => call[0] === 'set'), false, 'Browsing or dismissing never changes the mode');
    s.node('np-mode-select').click();
    s.window.document.body.dispatchEvent(new s.window.Event('pointerdown', { bubbles: true }));
    assert.equal(s.node('np-mode-menu').hidden, true);
    s.node('np-mode-select').click();
    s.node('np-back-btn').focus();
    assert.equal(s.node('np-mode-menu').hidden, true, 'Tabbing out dismisses the menu');
});

test('sidebar follows station IDs and Shuffle across song changes and collection rerenders', t => {
    const s = setup(t);
    s.ui.state.stations = [
        { id: 'station-1', name: 'First Radio', type: 'station' },
        { id: 'station-2', name: 'The Current Artist Radio', type: 'station' }
    ];
    s.ui.renderStations();
    const active = () => Array.from(s.window.document.querySelectorAll('#stations-list .active'), item => item.id || item.dataset.id);
    assert.deepEqual(active(), ['station-1']);
    s.ui.update({ artist: 'The Current Artist' });
    assert.deepEqual(active(), ['station-1'], 'The song artist must not determine the station');
    s.ui.update({ stationId: 'shuffle-id', isShuffle: true });
    assert.deepEqual(active(), ['shuffle-stations-btn']);
    s.ui.renderStations();
    assert.deepEqual(active(), ['shuffle-stations-btn']);
    assert.equal(s.node('shuffle-stations-btn').getAttribute('aria-current'), 'true');
    s.ui.update({ stationId: 'station-2', isShuffle: false, track: null, stationLoading: true });
    assert.deepEqual(active(), ['station-2'], 'Station selection updates even while the first song loads');
    assert.equal(s.node('shuffle-stations-btn').hasAttribute('aria-current'), false);
    s.ui.update({ stationId: null });
    assert.deepEqual(active(), []);
});

test('the in-app listening dialog defaults to keeping playback paused and only submits explicit choices', async t => {
    const s = setup(t);
    s.ui.update({ streamBlocked: true, streamPrompt: { id: 7, pending: false } });
    assert.equal(s.node('stream-conflict-dialog').open, true);
    assert.equal(s.window.document.activeElement.id, 'stream-keep-listening');
    assert.equal(s.calls.length, 0);
    s.node('stream-conflict-dialog').dispatchEvent(new s.window.Event('cancel', { cancelable: true }));
    await tick();
    assert.deepEqual(s.calls, [['takeover', 7, false]]);
    assert.equal(s.node('stream-conflict-dialog').open, false);
    s.ui.update({ streamPrompt: { id: 8, pending: false } });
    s.node('stream-dialog-close').click();
    await tick();
    assert.deepEqual(s.calls.at(-1), ['takeover', 8, false]);
    let finish;
    s.player.resolveStreamConflict = async (id, takeOver) => {
        s.calls.push(['takeover', id, takeOver]);
        return new Promise(resolve => { finish = resolve; });
    };
    s.ui.update({ streamPrompt: { id: 9, pending: false } });
    s.node('stream-take-over').click();
    s.node('stream-take-over').click();
    s.node('stream-conflict-dialog').dispatchEvent(new s.window.Event('cancel', { cancelable: true }));
    assert.equal(s.calls.filter(call => call[1] === 9).length, 1);
    assert.deepEqual(s.calls.at(-1), ['takeover', 9, true]);
    assert.equal(s.node('stream-keep-listening').disabled, true);
    assert.equal(s.node('stream-dialog-status').hidden, false);
    s.ui.update({ streamPrompt: null });
    finish({ success: true });
    await tick();
    assert.equal(s.node('stream-conflict-dialog').open, false);
});

test('station removal uses a themed, escaped confirmation; Cancel, close and Escape never remove or play a station', async t => {
    const s = setup(t);
    s.ui.state.stations = [{ id: 'station-1', name: 'Thunder <Live> "Radio"', type: 'station' }];
    s.ui.renderStations();
    s.window.api.content.playItem = () => s.calls.push(['play']);
    s.window.api.content.removeStation = async id => { s.calls.push(['remove', id]); return true; };
    for (const action of ['station-remove-cancel', 'station-remove-close', 'Escape']) {
        s.window.document.querySelector('.delete-btn').click();
        assert.equal(s.node('station-remove-dialog').open, true);
        assert.equal(s.window.document.activeElement.id, 'station-remove-cancel');
        assert.equal(s.node('station-remove-name').textContent, 'Thunder <Live> "Radio"');
        assert.equal(s.node('station-remove-name').childElementCount, 0);
        if (action === 'Escape') s.node('station-remove-dialog').dispatchEvent(new s.window.Event('cancel', { cancelable: true }));
        else s.node(action).click();
        await tick();
        assert.equal(s.node('station-remove-dialog').open, false);
    }
    assert.deepEqual(s.calls, []);
});

test('station removal submits the confirmed ID once, survives a sidebar refresh, and handles failure with retry', async t => {
    const s = setup(t);
    s.ui.state.stations = [{ id: 'station-1', name: 'First Radio', type: 'station' }];
    s.ui.renderStations();
    let finish;
    s.window.api.content.removeStation = async id => {
        s.calls.push(['remove', id]);
        return new Promise(resolve => { finish = resolve; });
    };
    s.window.document.querySelector('.delete-btn').click();
    s.node('station-remove-confirm').click();
    s.node('station-remove-confirm').click();
    s.node('station-remove-dialog').dispatchEvent(new s.window.Event('cancel', { cancelable: true }));
    assert.deepEqual(s.calls, [['remove', 'station-1']]);
    assert.equal(s.node('station-remove-dialog').open, true);
    assert.equal(s.node('station-remove-cancel').disabled, true);
    assert.equal(s.node('station-remove-status').hidden, false);
    s.ui.state.stations.unshift({ id: 'station-2', name: 'Other Radio', type: 'station' });
    s.ui.renderStations();
    finish(false);
    await tick();
    assert.equal(s.node('station-remove-dialog').open, true);
    assert.equal(s.node('station-remove-error').hidden, false);
    assert.equal(s.node('station-remove-confirm').disabled, false);
    s.node('station-remove-confirm').click();
    assert.deepEqual(s.calls.at(-1), ['remove', 'station-1']);
    finish(true);
    await tick();
    assert.equal(s.node('station-remove-dialog').open, false);
});

test('station removal recovers from an IPC exception without leaving controls disabled', async t => {
    const s = setup(t);
    s.ui.state.stations = [{ id: 'station-1', name: 'First Radio', type: 'station' }];
    s.ui.renderStations();
    s.window.api.content.removeStation = async () => { throw new Error('IPC unavailable'); };
    s.window.document.querySelector('.delete-btn').click();
    s.node('station-remove-confirm').click();
    await tick();
    assert.equal(s.node('station-remove-dialog').open, true);
    assert.equal(s.node('station-remove-confirm').disabled, false);
    assert.equal(s.node('station-remove-cancel').disabled, false);
    assert.match(s.node('station-remove-error').textContent, /try again/);
    s.node('station-remove-cancel').click();
    assert.equal(s.node('station-remove-dialog').open, false);
});
