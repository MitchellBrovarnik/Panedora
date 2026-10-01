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
        { id: 987654, name: 'Curated <Mix>', available: false }
    ], ...extra };
}

function setup(t) {
    const root = path.join(__dirname, '..');
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
        url: 'https://panedora.test/', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    const calls = [];
    const player = {
        getStationModes: async stationId => {
            calls.push(['get', stationId]);
            window.testUI.update({ stationModes: modes() });
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
        window.testUI = { state: AppState, update: updatePlayerUI, render: renderPage };
        initEventListeners();
    `);
    const ui = window.testUI;
    ui.state.isLoggedIn = true;
    ui.state.isLoading = false;
    ui.update({
        stationId: 'station-1', stationName: 'Fixture Radio', track: 'Current Song',
        trackToken: 'current', feedback: 'thumbUp', isPlaying: true,
        stationModes: { status: 'idle' }
    });
    ui.render('home');
    t.after(() => window.close());
    const node = id => window.document.getElementById(id);
    const open = () => node('now-playing-art').click();
    const select = value => {
        const element = node('np-mode-select');
        element.value = String(value);
        element.dispatchEvent(new window.Event('change'));
    };
    return { window, ui, player, calls, node, open, select };
}

test('artwork opens tuning above history; only actual modes appear and unavailable options are disabled', async t => {
    const s = setup(t);
    assert.equal(s.node('np-mode-select'), null);
    assert.equal(s.calls.length, 0);
    s.open();
    await tick();
    assert.deepEqual(s.calls, [['get', 'station-1']]);
    assert.equal(s.node('np-mode-select').value, '0');
    assert.deepEqual(Array.from(s.node('np-mode-select').options, option => option.value), ['0', '1091989', '5', '987654']);
    assert.equal(s.node('np-mode-select').options[2].disabled, true);
    assert.match(s.node('np-mode-select').options[2].textContent, /Premium required/);
    assert.match(s.node('np-mode-select').options[3].textContent, /Curated <Mix>/);
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
    assert.equal(s.node('np-mode-select').disabled, true);
    assert.equal(s.node('np-mode-select').options.length, 1, 'Only the disabled placeholder remains');
    assert.match(s.node('np-mode-status').textContent, /does not offer modes/);
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
