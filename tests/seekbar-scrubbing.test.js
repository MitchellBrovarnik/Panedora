const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function setup(t, { audio = false } = {}) {
    const root = path.join(__dirname, '..');
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
        url: 'https://panedora.test/', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    t.after(() => window.close());
    const seeks = [];
    const events = {};
    const api = {
        player: { setVolume() {}, seek: async seconds => { seeks.push(seconds); return { success: true }; } },
        window: {}, content: {},
        discord: { onStatus() {}, getStatus: async () => ({ enabled: false, configured: true, status: 'disabled' }), reportPlayback() {} },
        settings: { getVolume: async () => ({ remember: false, volume: 100 }), getLegacyMiniplayer: async () => false,
            saveVolume: async () => true }
    };
    for (const name of ['State', 'Collection', 'SearchResults', 'LoginStatus', 'MiniMode', 'Error', 'UpdateNotice']) {
        api['on' + name] = listener => { events[name] = listener; };
    }
    window.api = api;
    window.eval(fs.readFileSync(path.join(root, 'components.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(root, 'renderer.js'), 'utf8') + `
        document.removeEventListener('DOMContentLoaded', init);
        window.testUI = { update: updatePlayerUI, state: AppState };
        initEventListeners();
        initAPIListeners();
    `);
    window.testUI.state.isLoggedIn = true;
    window.testUI.state.isLoading = false;

    // A fake audio element: jsdom does not implement media playback or seeking.
    let element = null;
    if (audio) {
        element = window.document.createElement('audio');
        let time = 0;
        Object.defineProperties(element, {
            duration: { value: 200, configurable: true },
            currentTime: { get: () => time, set: value => { time = value; seeks.push(['audio', value]); }, configurable: true }
        });
        window.document.body.appendChild(element);
    }

    const node = id => window.document.getElementById(id);
    const bars = { footer: node('progress-bar'), classic: node('classic-progress-bar') };
    // Every bar is 200px wide starting at x=100, so x=150 is 25%.
    for (const bar of Object.values(bars)) {
        bar.getBoundingClientRect = () => ({ left: 100, right: 300, width: 200, top: 0, bottom: 3, height: 3 });
    }
    const pointer = (bar, type, x, extra = {}) => {
        const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0, ...extra });
        Object.defineProperty(event, 'pointerId', { value: extra.pointerId ?? 1 });
        if ('isPrimary' in extra) Object.defineProperty(event, 'isPrimary', { value: extra.isPrimary });
        bar.dispatchEvent(event);
        return event;
    };
    return { window, ui: window.testUI, node, bars, seeks, events, element, pointer,
        fill: () => node('progress-fill').style.width, time: () => node('current-time').textContent,
        classicFill: () => node('classic-progress-fill').style.width,
        enterClassic: () => events.MiniMode({ isMini: true, legacy: true }) };
}

const playing = { trackToken: 'now', track: 'Now', artist: 'Artist', isPlaying: true, duration: 200, time: 20 };

test('dragging moves the bar and time with the pointer and seeks once, on release', t => {
    const s = setup(t);
    s.ui.update(playing);
    const bar = s.bars.footer;
    s.pointer(bar, 'pointerdown', 120);
    assert.equal(bar.classList.contains('scrubbing'), true);
    assert.equal(s.fill(), '10%');
    assert.equal(s.time(), '0:20');
    s.pointer(bar, 'pointermove', 150);
    assert.equal(s.fill(), '25%');
    assert.equal(s.time(), '0:50');
    s.pointer(bar, 'pointermove', 250);
    assert.equal(s.fill(), '75%');
    assert.equal(s.time(), '2:30');
    assert.deepEqual(s.seeks, [], 'Nothing is sought while dragging');
    s.pointer(bar, 'pointerup', 250);
    assert.deepEqual(s.seeks, [150], 'One seek, to where the drag ended');
    assert.equal(bar.classList.contains('scrubbing'), false);
    // Moves after the release are ignored.
    s.pointer(bar, 'pointermove', 110);
    assert.equal(s.fill(), '75%');
});

test('a plain click still seeks, exactly once', t => {
    const s = setup(t);
    s.ui.update(playing);
    s.pointer(s.bars.footer, 'pointerdown', 200);
    s.pointer(s.bars.footer, 'pointerup', 200);
    assert.deepEqual(s.seeks, [100]);
    s.bars.footer.dispatchEvent(new s.window.MouseEvent('click', { bubbles: true, clientX: 200 }));
    assert.deepEqual(s.seeks, [100], 'The follow-up click event does not seek again');
});

test('dragging past either end is clamped to the start and the end of the song', t => {
    const s = setup(t);
    s.ui.update(playing);
    s.pointer(s.bars.footer, 'pointerdown', 150);
    s.pointer(s.bars.footer, 'pointermove', -500);
    assert.equal(s.fill(), '0%');
    assert.equal(s.time(), '0:00');
    s.pointer(s.bars.footer, 'pointermove', 5000);
    assert.equal(s.fill(), '100%');
    assert.equal(s.time(), '3:20');
    s.pointer(s.bars.footer, 'pointerup', 5000);
    assert.deepEqual(s.seeks, [200]);
    s.pointer(s.bars.footer, 'pointerdown', 0);
    s.pointer(s.bars.footer, 'pointerup', 0);
    assert.deepEqual(s.seeks, [200, 0]);
});

test('playback updates do not fight the drag, and resume once it ends', t => {
    const s = setup(t);
    s.ui.update(playing);
    assert.equal(s.fill(), '10%');
    s.pointer(s.bars.footer, 'pointerdown', 200);
    assert.equal(s.fill(), '50%');
    s.ui.update({ time: 30, duration: 200 });
    assert.equal(s.fill(), '50%', 'The playing position does not pull the bar back');
    assert.equal(s.time(), '1:40');
    s.pointer(s.bars.footer, 'pointerup', 200);
    s.ui.update({ time: 120, duration: 200 });
    assert.equal(s.fill(), '60%', 'Normal updates take over again');
});

test('a cancelled drag, other buttons and a second pointer do nothing', t => {
    const s = setup(t);
    s.ui.update(playing);
    const bar = s.bars.footer;
    s.pointer(bar, 'pointerdown', 250, { button: 2 });
    assert.equal(bar.classList.contains('scrubbing'), false, 'Right-click is ignored');
    s.pointer(bar, 'pointerdown', 250, { isPrimary: false });
    assert.equal(bar.classList.contains('scrubbing'), false, 'Secondary touches are ignored');

    s.pointer(bar, 'pointerdown', 250);
    assert.equal(s.fill(), '75%');
    s.pointer(bar, 'pointermove', 150, { pointerId: 2 });
    assert.equal(s.fill(), '75%', 'A different pointer cannot move the drag');
    s.pointer(bar, 'pointerup', 150, { pointerId: 2 });
    assert.equal(bar.classList.contains('scrubbing'), true);
    s.pointer(bar, 'pointercancel', 250);
    assert.equal(bar.classList.contains('scrubbing'), false);
    assert.deepEqual(s.seeks, [], 'Cancelling never seeks');
    assert.equal(s.fill(), '10%', 'The bar goes back to the playing position');
    assert.equal(s.time(), '0:20');
});

test('losing pointer capture mid-drag cancels it without seeking', t => {
    const s = setup(t);
    s.ui.update(playing);
    s.pointer(s.bars.footer, 'pointerdown', 250);
    s.pointer(s.bars.footer, 'lostpointercapture', 250);
    assert.equal(s.bars.footer.classList.contains('scrubbing'), false);
    assert.deepEqual(s.seeks, []);
    // Capture is also reported after a normal release; that must not cancel anything.
    s.pointer(s.bars.footer, 'pointerdown', 250);
    s.pointer(s.bars.footer, 'pointerup', 250);
    s.pointer(s.bars.footer, 'lostpointercapture', 250);
    assert.deepEqual(s.seeks, [150]);
});

test('a new song ends a drag in progress instead of seeking the new song', t => {
    const s = setup(t);
    s.ui.update(playing);
    s.pointer(s.bars.footer, 'pointerdown', 250);
    s.ui.update({ trackToken: 'next', track: 'Next', duration: 100, time: 0 });
    assert.equal(s.bars.footer.classList.contains('scrubbing'), false);
    s.pointer(s.bars.footer, 'pointerup', 250);
    assert.deepEqual(s.seeks, [], 'The release after the song changed seeks nothing');
});

test('with a playing audio element the song itself is sought, once, after the drag', t => {
    const s = setup(t, { audio: true });
    s.ui.update(playing);
    s.pointer(s.bars.footer, 'pointerdown', 120);
    s.pointer(s.bars.footer, 'pointermove', 200);
    s.pointer(s.bars.footer, 'pointermove', 300);
    assert.deepEqual(s.seeks, [], 'The audio is not seeked while dragging');
    s.pointer(s.bars.footer, 'pointerup', 300);
    assert.deepEqual(s.seeks, [['audio', 200]]);
    assert.equal(s.fill(), '100%');
    assert.equal(s.time(), '3:20');
});

test('the classic player\u2019s bar drags too, and both bars show the same position', t => {
    const s = setup(t);
    s.ui.update(playing);
    s.enterClassic();
    const bar = s.bars.classic;
    s.pointer(bar, 'pointerdown', 120);
    assert.equal(bar.classList.contains('scrubbing'), true);
    s.pointer(bar, 'pointermove', 200);
    assert.equal(s.classicFill(), '50%');
    assert.equal(s.node('classic-current-time').textContent, '1:40');
    assert.equal(s.fill(), '50%', 'The footer bar mirrors it');
    s.ui.update({ time: 30, duration: 200 });
    assert.equal(s.classicFill(), '50%', 'Playback updates wait for the drag to finish');
    assert.deepEqual(s.seeks, []);
    s.pointer(bar, 'pointerup', 200);
    assert.deepEqual(s.seeks, [100]);
    assert.equal(s.node('classic-progress-bar').getAttribute('aria-valuenow'), '50');
});

test('the stylesheet makes the bars easy to grab and shows the thumb while dragging', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    const block = selector => {
        const match = new RegExp('(?:^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}').exec(css);
        assert.ok(match, 'missing rule ' + selector);
        return match[1];
    };
    assert.match(block('.progress-bar'), /touch-action: none;/);
    assert.match(block('.progress-bar'), /user-select: none;/);
    assert.match(block('.progress-bar::before'), /top: -6px;[\s\S]*bottom: -6px;/, 'An invisible band around the 3px bar');
    assert.ok(css.includes('.progress-bar:hover,\n.progress-bar.scrubbing {\n    height: 5px;'));
    assert.ok(css.includes('.progress-bar:hover .progress-fill::after,\n.progress-bar.scrubbing .progress-fill::after {'));
    assert.match(block('.progress-bar.scrubbing .progress-fill'), /transition: none;/);
    // The classic player's grab band must not start a window drag.
    assert.ok(css.includes('.classic-controls button,\n.classic-progress {\n    -webkit-app-region: no-drag;'));
});
