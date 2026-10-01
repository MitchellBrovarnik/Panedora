const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual renderer listeners with a small DOM/audio stand-in. These
// checks verify playback ordering; native Electron fixtures cover real media.
function setup() {
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
                ...element(), src: '', paused: true, currentTime: 0, plays: 0,
                play() { this.plays++; this.paused = false; this.dispatch('play'); return Promise.resolve(); },
                pause() { if (!this.paused) { this.paused = true; this.dispatch('pause'); } }
            };
            return audio;
        }
    };
    const api = {
        player: { play: async () => { resumeRequests++; return { success: true }; }, pause: async () => ({ success: true }) },
        onState: listener => { onState = listener; },
        onMiniMode: listener => { onMiniMode = listener; },
        onCollection() {}, onSearchResults() {}, onLoginStatus() {}, onError() {}
    };
    const source = fs.readFileSync(path.join(__dirname, '..', 'components.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8') + '\ninitEventListeners(); initAPIListeners();';
    vm.runInNewContext(source, {
        document, window: { api, addEventListener() {} },
        navigator: { mediaSession: { setActionHandler: (action, handler) => mediaActions.set(action, handler) } },
        MediaMetadata: class {}, requestAnimationFrame: callback => callback(),
        setTimeout, clearTimeout, console: { log() {}, error() {}, warn() {} }
    }, { filename: 'renderer.js' });
    const state = (value = {}) => onState({ audioURL: 'https://fixture.invalid/buffer.wav', trackToken: 'saved-track', isPlaying: false, ...value });
    return {
        state, node: document.getElementById,
        mini: () => onMiniMode({ isMini: true }),
        action: name => mediaActions.get(name)(),
        get audio() { return audio; },
        get resumeRequests() { return resumeRequests; }
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
