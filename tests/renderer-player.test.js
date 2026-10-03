const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual renderer listeners with a small DOM/audio stand-in. These
// checks verify playback ordering; native Electron fixtures cover real media.
function setup({ deferPlay = false } = {}) {
    function element() {
        const listeners = new Map();
        const classes = new Set();
        return {
            style: {},
            classList: {
                contains: name => classes.has(name),
                add: name => classes.add(name),
                remove: name => classes.delete(name),
                toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
            },
            addEventListener: (event, listener) => listeners.set(event, listener),
            dispatch: event => listeners.get(event)?.(),
            setAttribute(name, value) { this[name] = value; },
            getAttribute(name) { return this[name]; }
        };
    }
    const nodes = new Map();
    let audio;
    let onState;
    let onMiniMode;
    let resumeRequests = 0;
    let pauseRequests = 0;
    const nextRequests = [];
    const playRequests = [];
    const timers = new Set();
    const testWindow = { addEventListener() {} };
    let visualizerInits = 0;
    testWindow.visualizer = { init() { visualizerInits++; } };
    const mediaActions = new Map();
    const document = {
        getElementById: id => {
            if (!nodes.has(id)) nodes.set(id, element());
            return nodes.get(id);
        },
        querySelector: selector => selector === 'audio' ? audio : null,
        querySelectorAll: () => [],
        addEventListener() {},
        body: { ...element(), appendChild() {} },
        createElement: type => {
            assert.equal(type, 'audio');
            audio = {
                ...element(), paused: true, currentTime: 0, plays: 0, error: null, ended: false,
                get src() { return this._src || ''; },
                set src(value) { this._src = value; this.currentTime = 0; this.error = null; this.ended = false; this.paused = true; },
                play() {
                    this.plays++; this.paused = false; this.dispatch('play');
                    if (deferPlay) return new Promise((resolve, reject) => playRequests.push({ resolve, reject }));
                    return Promise.resolve();
                },
                pause() { if (!this.paused) { this.paused = true; this.dispatch('pause'); } }
            };
            return audio;
        }
    };
    const api = {
        player: { play: async () => { resumeRequests++; return { success: true }; },
            pause: async () => { pauseRequests++; return { success: true }; },
            next: async expected => { nextRequests.push(expected); } },
        onState: listener => { onState = listener; },
        onMiniMode: listener => { onMiniMode = listener; },
        onCollection() {}, onSearchResults() {}, onLoginStatus() {}, onError() {}
    };
    const source = fs.readFileSync(path.join(__dirname, '..', 'components.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8') + '\ninitEventListeners(); initAPIListeners(); window.testState = AppState;';
    testWindow.api = api;
    vm.runInNewContext(source, {
        document, window: testWindow,
        navigator: { mediaSession: { setActionHandler: (action, handler) => mediaActions.set(action, handler) } },
        MediaMetadata: class {}, requestAnimationFrame: callback => callback(),
        setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; },
        clearTimeout: timer => timers.delete(timer), console: { log() {}, error() {}, warn() {} }
    }, { filename: 'renderer.js' });
    const state = (value = {}) => onState({ audioURL: 'https://fixture.invalid/buffer.wav', trackToken: 'saved-track', playbackGeneration: 1, isPlaying: false, ...value });
    testWindow.testState.isLoggedIn = true;
    return {
        state, node: document.getElementById,
        mini: () => onMiniMode({ isMini: true }),
        action: name => mediaActions.get(name)(),
        get audio() { return audio; },
        get resumeRequests() { return resumeRequests; },
        get pauseRequests() { return pauseRequests; }, get visualizerInits() { return visualizerInits; },
        nextRequests, playRequests, timers,
        fireTimers: () => { for (const timer of [...timers]) { timers.delete(timer); timer.callback(); } }
    };
}

test('normal and mini Play and Previous wait for the approved resume state', () => {
    for (const mini of [false, true]) {
        for (const button of ['play-pause-btn', 'prev-btn']) {
            const s = setup();
            s.state();
            if (mini) s.mini();
            s.audio.currentTime = 4;
            s.node(button).dispatch('click');
            assert.equal(s.resumeRequests, 1);
            assert.equal(s.audio.plays, 0, button + ' must not play buffered audio before approval');
            s.state({ isPlaying: true, resumePlayback: true });
            assert.equal(s.audio.paused, false);
        }
    }
});

test('a failed old song cannot auto-skip a new song or apply its late play completion', async () => {
    const s = setup({ deferPlay: true });
    s.state({ isPlaying: true });
    s.audio.error = { code: 2 };
    s.audio.dispatch('error');
    s.audio.dispatch('error');
    assert.equal(s.timers.size, 1, 'One recovery per failed source');
    s.state({ trackToken: 'new-track', audioURL: 'https://fixture.invalid/new.wav', isPlaying: true });
    assert.equal(s.timers.size, 0);
    s.playRequests[0].resolve();
    await Promise.resolve();
    assert.equal(s.visualizerInits, 0, 'Old play completion is ignored');
    s.playRequests[1].resolve();
    await Promise.resolve();
    assert.equal(s.visualizerInits, 1);
    s.fireTimers();
    assert.equal(s.nextRequests.length, 0);
});

test('current-song recovery carries its identity and is cancelled by pause or stream loss', () => {
    for (const action of ['recover', 'pause', 'blocked']) {
        const s = setup({ deferPlay: true });
        s.state({ isPlaying: true });
        s.audio.error = { code: 2 };
        s.audio.dispatch('error');
        if (action === 'pause') s.state({ isPlaying: false, pausePlayback: true });
        if (action === 'blocked') s.state({ audioURL: null, streamBlocked: true });
        s.fireTimers();
        assert.equal(s.nextRequests.length, action === 'recover' ? 1 : 0);
        if (action === 'recover') assert.equal(s.nextRequests[0].trackToken, 'saved-track');
    }
});

test('natural ending advances once and stale pause/end events cannot interrupt a loading replacement', () => {
    const s = setup({ deferPlay: true });
    s.state({ isPlaying: true });
    s.audio.dispatch('ended');
    assert.equal(s.nextRequests.length, 0, 'A queued end event is ignored unless the current source ended');
    s.audio.ended = true;
    s.audio.dispatch('ended');
    s.audio.dispatch('ended');
    assert.equal(s.nextRequests.length, 1);
    s.state({ trackToken: 'replacement', audioURL: 'https://fixture.invalid/replacement.wav', isPlaying: true, duration: 180 });
    s.audio.dispatch('pause');
    s.audio.dispatch('ended');
    assert.equal(s.pauseRequests, 0);
    assert.equal(s.nextRequests.length, 1);
    assert.equal(s.node('current-time').textContent, '0:00');
    assert.equal(s.node('progress-fill').style.width, '0%');
});

test('OS Play and Previous wait for Pandora approval before playing buffered audio', () => {
    for (const action of ['play', 'previoustrack']) {
        const s = setup();
        s.state();
        s.audio.currentTime = 4;
        s.action(action);
        assert.equal(s.resumeRequests, 1);
        assert.equal(s.audio.plays, 0);
        s.state({ isPlaying: true, resumePlayback: true });
        assert.equal(s.audio.paused, false);
    }
});

test('conflicts stop buffered audio and saved thumbs survive source and partial state updates in both players', () => {
    const s = setup();
    s.state({ isPlaying: true, feedback: 'thumbUp' });
    s.state({ audioURL: 'https://fixture.invalid/next.wav', isPlaying: true, feedback: 'thumbUp' });
    s.state({ volume: 50, audioURL: 'https://fixture.invalid/next.wav', isPlaying: true });
    for (const id of ['mini-thumb-up', 'np-thumbup', 'heart-btn']) {
        assert.equal(s.node(id).classList.contains('liked'), true);
    }
    s.state({ audioURL: null, streamBlocked: true });
    assert.equal(s.audio.paused, true);
    assert.equal(s.audio.src, '');
    const plays = s.audio.plays;
    s.node('play-pause-btn').dispatch('click');
    assert.equal(s.audio.plays, plays, 'Reopening the listening choice must not start audio');
    s.state({ audioURL: 'https://fixture.invalid/reclaimed.wav', isPlaying: true, streamBlocked: false, feedback: 'thumbUp' });
    assert.equal(s.audio.paused, false);
    assert.equal(s.node('mini-thumb-up').classList.contains('liked'), true);
    assert.equal(s.node('np-thumbup').classList.contains('liked'), true);
});
