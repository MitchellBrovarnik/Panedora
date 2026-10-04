const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual renderer listeners with a small DOM/audio stand-in. These
// checks verify playback ordering; native Electron fixtures cover real media.
function setup({ deferPlay = false, withDiscord = false } = {}) {
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
            addEventListener: (event, listener) => listeners.set(event, [...(listeners.get(event) || []), listener]),
            dispatch: event => { for (const listener of listeners.get(event) || []) listener(); },
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
    const toasts = [];
    const discordReports = [];
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
        body: { ...element(), appendChild(node) { if (node.className === 'error-toast') toasts.push(node); } },
        createElement: type => {
            if (type === 'div') return { ...element(), remove() {} };
            assert.equal(type, 'audio');
            audio = {
                ...element(), paused: true, currentTime: 0, plays: 0, error: null, ended: false, readyState: 4,
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
    if (withDiscord) api.discord = {
        onStatus() {}, getStatus: async () => ({ enabled: true, configured: true, status: 'idle' }),
        reportPlayback: value => discordReports.push(value)
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
        nextRequests, playRequests, timers, toasts, discordReports,
        fireTimers: () => { for (const timer of [...timers]) { timers.delete(timer); timer.callback(); } }
    };
}

test('Discord observes playing, seeking and pause without starting audio or publishing loading tracks', () => {
    const s = setup({ withDiscord: true });
    s.state({ isPlaying: true });
    assert.equal(s.discordReports.length, 0, 'play is not the same as actual playing');
    s.audio.currentTime = 12;
    s.audio.dispatch('playing');
    assert.equal(s.discordReports.at(-1).playing, true);
    assert.equal(s.discordReports.at(-1).position, 12);
    s.audio.seeking = true; s.audio.dispatch('seeking');
    assert.equal(s.discordReports.at(-1).playing, false);
    assert.equal(s.discordReports.at(-1).paused, false);
    s.audio.currentTime = 32; s.audio.seeking = false; s.audio.dispatch('seeked');
    assert.equal(s.discordReports.at(-1).position, 32);
    assert.equal(s.discordReports.at(-1).playing, true);
    const callsBefore = s.resumeRequests;
    s.audio.pause();
    assert.equal(s.discordReports.at(-1).playing, false);
    assert.equal(s.discordReports.at(-1).paused, true);
    s.audio.currentTime = 40; s.audio.dispatch('seeked');
    assert.equal(s.discordReports.at(-1).position, 40);
    assert.equal(s.discordReports.at(-1).paused, true);
    assert.equal(s.resumeRequests, callsBefore);
    assert.equal(s.audio.plays, 1);
});

test('Discord follows a renewed playback generation even when the current source is reused', () => {
    const s = setup({ withDiscord: true });
    s.state({ isPlaying: true }); s.audio.dispatch('playing');
    s.audio.currentTime = 12;
    s.state({ isPlaying: true, playbackGeneration: 2 });
    assert.equal(s.discordReports.at(-1).playbackGeneration, 2);
    assert.equal(s.discordReports.at(-1).position, 12);
    assert.equal(s.audio.plays, 1, 'Presence never reloads the audio');
});

test('Discord ignores stale media events and waits for the replacement song to play', () => {
    const s = setup({ withDiscord: true });
    s.state({ isPlaying: true }); s.audio.dispatch('playing');
    const reports = s.discordReports.length;
    s.audio.dispatch('pause'); s.audio.dispatch('ended'); s.audio.dispatch('error'); s.audio.dispatch('emptied');
    assert.equal(s.discordReports.length, reports);
    s.state({ isPlaying: true, trackToken: 'next', playbackGeneration: 2, audioURL: 'https://fixture.invalid/next.wav' });
    s.audio.readyState = 0; s.audio.dispatch('playing'); s.audio.dispatch('timeupdate');
    assert.equal(s.discordReports.length, reports);
    s.audio.readyState = 4; s.audio.dispatch('playing');
    assert.equal(s.discordReports.at(-1).trackToken, 'next');
    assert.equal(s.discordReports.at(-1).playbackGeneration, 2);
    s.audio.readyState = 2; s.audio.dispatch('waiting');
    assert.equal(s.discordReports.at(-1).playing, false);
});

test('Discord recovers from a missed playing event when the current audio advances', () => {
    const s = setup({ withDiscord: true });
    s.state({ isPlaying: true }); s.audio.dispatch('playing');
    s.state({ isPlaying: true, trackToken: 'next', audioURL: 'https://fixture.invalid/next.wav' });
    s.audio.readyState = 2; s.audio.dispatch('playing');
    s.audio.readyState = 4; s.audio.currentTime = 0.25; s.audio.dispatch('timeupdate');
    assert.equal(s.discordReports.at(-1).trackToken, 'next');
    assert.equal(s.discordReports.at(-1).playing, true);
    s.audio.readyState = 2; s.audio.dispatch('waiting');
    assert.equal(s.discordReports.at(-1).playing, false);
    s.audio.readyState = 4; s.audio.currentTime = 0.5; s.audio.dispatch('timeupdate');
    assert.equal(s.discordReports.at(-1).playing, true, 'Progress recovers without a pause/resume or window focus');
});

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

test('three failed audio sources stop automatic skipping and show the existing error toast', () => {
    const s = setup({ deferPlay: true });
    for (let i = 1; i <= 3; i++) {
        s.state({ isPlaying: true, trackToken: 'failed-' + i, audioURL: 'https://fixture.invalid/failed-' + i + '.wav' });
        s.audio.error = { code: 2 };
        s.audio.paused = true;
        s.audio.dispatch('error');
        if (i < 3) s.fireTimers();
    }
    assert.equal(s.nextRequests.length, 2);
    assert.equal(s.pauseRequests, 1);
    assert.equal(s.node('play-pause-btn').getAttribute('aria-label'), 'Play');
    assert.equal(s.toasts.length, 1);
    assert.match(s.toasts[0].textContent, /Audio could not be loaded/);
    s.fireTimers();
    assert.equal(s.nextRequests.length, 2, 'The error notice does not schedule another skip');
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
