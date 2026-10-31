const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t, { settings = {} } = {}) {
    const root = path.join(__dirname, '..');
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
        url: 'https://panedora.test/', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    t.after(() => window.close());
    // Deterministic timers so the popover's fade-out can be stepped through.
    const timers = new Map();
    let nextTimer = 0;
    window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
    window.clearTimeout = id => timers.delete(id);
    const saves = [];
    const api = {
        player: { setVolume: () => {} },
        window: {}, content: {},
        discord: { onStatus() {}, getStatus: async () => ({ enabled: false, configured: true, status: 'disabled' }), reportPlayback() {} },
        settings: {
            getVolume: async () => ({ volume: 100 }),
            saveVolume: async volume => { saves.push(volume); return true; },
            ...settings
        }
    };
    for (const name of ['State', 'Collection', 'SearchResults', 'LoginStatus', 'MiniMode', 'Error', 'UpdateNotice']) {
        api['on' + name] = () => {};
    }
    window.api = api;
    window.eval(fs.readFileSync(path.join(root, 'components.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(root, 'renderer.js'), 'utf8') + `
        document.removeEventListener('DOMContentLoaded', init);
        window.testUI = { render: renderPage, load: loadVolumeSettings, apply: applyVolume, state: AppState };
        initEventListeners();
        initAPIListeners();
    `);
    window.testUI.state.isLoggedIn = true;
    window.testUI.state.isLoading = false;
    const node = id => window.document.getElementById(id);
    const fire = (target, type) => target.dispatchEvent(new window.Event(type, { bubbles: true }));
    const runTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } };
    const slider = node('volume-slider');
    const popover = node('volume-popover');
    const drag = value => { slider.value = String(value); fire(slider, 'input'); };
    return { window, ui: window.testUI, api, saves, timers, node, fire, runTimers, slider, popover, drag,
        visible: () => popover.classList.contains('visible') };
}

test('Panedora Settings has no volume-memory toggle', t => {
    const s = setup(t);
    s.ui.render('settings');
    const titles = [...s.window.document.querySelectorAll('.section-title')].map(el => el.textContent);
    assert.deepEqual(titles.slice(0, 2), ['Panedora Settings', 'Discord']);
    assert.equal(s.node('remember-volume-toggle'), null);
    assert.equal(s.node('remember-volume-description'), null);
    assert.equal(s.window.document.querySelector('.settings-section .setting-label').textContent, 'Use legacy miniplayer');
});

test('slider changes are always remembered, including mute', async t => {
    const s = setup(t);
    s.drag(35); s.fire(s.slider, 'change'); await tick();
    assert.deepEqual(s.saves, [35]);
    s.drag(50); s.fire(s.slider, 'change'); await tick();
    s.drag(0); s.fire(s.slider, 'change'); await tick();
    assert.deepEqual(s.saves, [35, 50, 0]);
});

test('a remembered volume is restored at startup, otherwise the slider stays at 100%', async t => {
    const muted = setup(t, { settings: { getVolume: async () => ({ volume: 0 }) } });
    await muted.ui.load();
    const audio = muted.window.document.createElement('audio');
    muted.window.document.body.appendChild(audio);
    muted.ui.apply(Number(muted.slider.value));
    assert.equal(muted.slider.value, '0');
    assert.equal(audio.volume, 0, 'Restoring 0% does not unmute playback');

    const restored = setup(t, { settings: { getVolume: async () => ({ volume: 25 }) } });
    await restored.ui.load();
    assert.equal(restored.slider.value, '25');
    assert.equal(restored.visible(), false, 'Restoring does not pop the percentage up');
    restored.ui.render('settings');
    assert.equal(restored.node('remember-volume-toggle'), null);
    restored.drag(60); restored.fire(restored.slider, 'change'); await tick();
    assert.deepEqual(restored.saves, [60]);

    for (const settings of [
        { getVolume: async () => ({ volume: 100 }) },
        { getVolume: async () => null },
        { getVolume: async () => { throw new Error('IPC failed'); } },
        { getVolume: undefined }
    ]) {
        const s = setup(t, { settings });
        await s.ui.load();
        assert.equal(s.slider.value, '100');
        s.drag(15); s.fire(s.slider, 'change'); await tick();
        assert.deepEqual(s.saves, [15], 'A failed startup read does not disable future saves');
    }
});

test('the percentage popover follows the thumb and only shows while the volume is adjusted', t => {
    const s = setup(t);
    assert.equal(s.visible(), false, 'Hidden until the slider is used');
    assert.equal(s.popover.getAttribute('aria-hidden'), 'true');
    assert.ok(s.popover.parentElement.classList.contains('volume-controls'), 'Sits in the volume control');
    s.fire(s.slider, 'mouseover');
    assert.equal(s.visible(), false, 'Hovering alone does not show it');

    // jsdom has no layout, so give the slider a 90px track starting 20px into the control.
    Object.defineProperty(s.slider, 'offsetWidth', { value: 90 });
    Object.defineProperty(s.slider, 'offsetLeft', { value: 20 });
    const left = () => parseFloat(s.popover.style.left);

    // Dragging: stays up through pauses, tracks the value, fades shortly after release.
    s.fire(s.slider, 'pointerdown');
    assert.equal(s.visible(), true);
    s.drag(72);
    assert.equal(s.popover.textContent, '72%');
    assert.ok(Math.abs(left() - (20 + 5.5 + 0.72 * 79)) < 0.01, 'Centered over the thumb at 72%');
    s.drag(10);
    assert.equal(s.popover.textContent, '10%');
    assert.ok(Math.abs(left() - (20 + 5.5 + 0.1 * 79)) < 0.01, 'Moves with the thumb');
    s.drag(0);
    assert.equal(left(), 25.5, 'Left end of the travel');
    s.drag(100);
    assert.equal(left(), 104.5, 'Right end of the travel');
    s.drag(10);
    s.runTimers();
    assert.equal(s.visible(), true, 'Still held, so it stays');
    s.fire(s.window.document.body, 'pointerup');
    assert.equal(s.visible(), true);
    assert.equal([...s.timers.values()].at(-1).delay, 250);
    s.runTimers();
    assert.equal(s.visible(), false);
});

test('keyboard changes show the popover briefly and leaving the slider hides it', t => {
    const s = setup(t);
    s.drag(80);
    assert.equal(s.visible(), true);
    assert.equal(s.popover.textContent, '80%');
    assert.equal([...s.timers.values()].at(-1).delay, 700);
    s.drag(81);
    assert.equal(s.timers.size, 1, 'Only one pending hide, restarted by each change');
    s.runTimers();
    assert.equal(s.visible(), false);
    s.drag(82);
    s.fire(s.slider, 'blur');
    assert.equal(s.visible(), false);
});

test('a drag cancelled by the system also releases the popover', t => {
    const s = setup(t);
    s.fire(s.slider, 'pointerdown');
    s.fire(s.window.document.body, 'pointercancel');
    s.runTimers();
    assert.equal(s.visible(), false);
    // A stray release without a drag does nothing.
    s.fire(s.window.document.body, 'pointerup');
    assert.equal(s.timers.size, 0);
});

test('the slider value sets the audio element or the visualizer gain', t => {
    const s = setup(t);
    const audio = s.window.document.createElement('audio');
    s.window.document.body.appendChild(audio);
    s.drag(30);
    assert.equal(audio.volume, 0.3);
    const gains = [];
    s.window.visualizer = { audioContext: {}, setVolume: value => gains.push(value) };
    s.drag(40);
    assert.deepEqual(gains, [0.4]);
    assert.equal(audio.volume, 1, 'The element stays at full signal when the visualizer owns the volume');
});
