const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
function track(rating = 0, token = 'track-1') {
    return { trackToken: token, songRating: rating, songTitle: token, audioURL: 'https://fixture.invalid/' + token };
}

function setup() {
    const handlers = new Map();
    const dialogs = [];
    const messages = [];
    const calls = [];
    const playlists = [];
    const electron = {
        app: { commandLine: { appendSwitch() {} }, on() {}, whenReady: () => new Promise(() => {}) },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        dialog: { showMessageBox: (parent, options) => new Promise(resolve => dialogs.push({ parent, options, resolve })) }
    };
    const api = {
        getPlaylist: async () => playlists.shift() || { tracks: [track()] },
        playbackResumed: async force => { calls.push(['resume', force]); return { success: true }; },
        playbackPaused: async () => { calls.push(['pause']); return true; },
        trackStarted: async () => {},
        addFeedback: async () => { calls.push(['addFeedback']); return { success: true, feedbackId: 'new-feedback' }; },
        deleteFeedback: async id => { calls.push(['deleteFeedback', id]); return { success: true }; },
        logout() {}
    };
    const window = { isDestroyed: () => false, webContents: { send: (name, data) => messages.push({ name, data }) } };
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8') + `
        api = testApi;
        uiWindow = testWindow;
        currentStations = [{stationId:'station-1'}, {stationId:'station-2'}];
        module.exports = { playStation, showStreamConflict, getCurrentState, thumbUp, thumbDown, pausePlayer, resumePlayer,
            seed: (tracks) => { currentStation = currentStations[0]; currentPlaylist = tracks; currentTrackIndex = 0; isPaused = false; tracks.forEach(rememberTrack); }
        };`;
    vm.runInNewContext(source, {
        module, testApi: api, testWindow: window,
        require: name => {
            if (name === 'electron') return electron;
            if (name === './pandora-api') return { getHighResArt: () => null };
            if (name === './config') return {};
            if (name === './pandora-verification') return { PandoraVerification: class { cancel() {} } };
            return require(name);
        },
        __dirname: path.join(__dirname, '..'), process,
        setTimeout, clearTimeout,
        console: { log() {}, error() {} }
    });
    return { ...module.exports, api, handlers, dialogs, messages, calls, playlists };
}

test('Let them listen pauses without sending a takeover request', async () => {
    const s = setup();
    s.playlists.push({ tracks: [], streamConflict: true });
    const pending = s.playStation('station-1');
    await tick();
    assert.equal(s.dialogs.length, 1);
    assert.equal(s.getCurrentState().streamBlocked, true);
    assert.equal(s.getCurrentState().audioURL, null);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(Array.from(s.dialogs[0].options.buttons), ['Let me listen', 'Let them listen']);
    s.dialogs[0].resolve({ response: 1 });
    await pending;
    assert.equal(s.getCurrentState().isPlaying, false);
    assert.deepEqual(s.calls, []);
});

test('Let me listen takes over once and loads the new queue with saved feedback', async () => {
    const s = setup();
    s.playlists.push({ tracks: [], streamConflict: true }, { tracks: [track(1)] });
    const pending = s.playStation('station-1');
    await tick();
    s.dialogs[0].resolve({ response: 0 });
    await pending;
    assert.deepEqual(s.calls, [['resume', true]]);
    assert.equal(s.getCurrentState().streamBlocked, false);
    assert.equal(s.getCurrentState().isPlaying, true);
    assert.equal(s.getCurrentState().feedback, 'thumbUp');
});

test('concurrent detections share one choice and rejected takeover does not loop', async () => {
    const s = setup();
    s.seed([track()]);
    s.api.playbackResumed = async () => { s.calls.push(['resume', true]); return { success: false, error: 'Still blocked' }; };
    const first = s.showStreamConflict('station-1');
    const second = s.showStreamConflict('station-1');
    assert.equal(first, second);
    assert.equal(s.dialogs.length, 1);
    s.dialogs[0].resolve({ response: 0 });
    await first;
    assert.equal(s.dialogs.length, 1);
    assert.equal(s.getCurrentState().isPlaying, false);
    assert.equal(s.calls.length, 1);
});

test('a repeated playlist conflict after takeover stays paused without another popup', async () => {
    const s = setup();
    s.playlists.push({ tracks: [], streamConflict: true }, { tracks: [], streamConflict: true, error: 'Still blocked' });
    const pending = s.playStation('station-1');
    await tick();
    s.dialogs[0].resolve({ response: 0 });
    await pending;
    assert.equal(s.dialogs.length, 1);
    assert.equal(s.getCurrentState().streamBlocked, true);
    assert.equal(s.getCurrentState().isPlaying, false);
});

test('an old popup cannot reclaim playback after switching stations', async () => {
    const s = setup();
    s.seed([track()]);
    const pending = s.showStreamConflict('station-1');
    await s.playStation('station-2');
    s.dialogs[0].resolve({ response: 0 });
    await pending;
    assert.equal(s.getCurrentState().stationId, 'station-2');
    assert.deepEqual(s.calls, []);
});

test('an old popup cannot reclaim playback after sign-out', async () => {
    const s = setup();
    s.seed([track()]);
    const pending = s.showStreamConflict('station-1');
    await s.handlers.get('AUTH:LOGOUT')();
    s.dialogs[0].resolve({ response: 0 });
    await pending;
    assert.deepEqual(s.calls, []);
    assert.equal(s.getCurrentState().trackToken, null);
});

test('ordinary playlist errors do not open a device conflict popup', async () => {
    const s = setup();
    s.playlists.push({ tracks: [], error: 'Network error' });
    await s.playStation('station-1');
    assert.equal(s.dialogs.length, 0);
    assert.equal(s.getCurrentState().streamBlocked, false);
});

test('normal pause and resume notify Pandora without forcing takeover', async () => {
    const s = setup();
    s.seed([track(1)]);
    await s.pausePlayer();
    await s.pausePlayer();
    await s.resumePlayer();
    assert.deepEqual(s.calls, [['pause'], ['resume', false]]);
    assert.equal(s.dialogs.length, 0);
    assert.equal(s.getCurrentState().feedback, 'thumbUp');
});

test('a pause during a slow resume keeps the player paused and concurrent resumes share a request', async () => {
    const s = setup();
    s.seed([track()]);
    await s.pausePlayer();
    s.calls.length = 0;
    let complete;
    s.api.playbackResumed = async force => {
        s.calls.push(['resume', force]);
        return new Promise(resolve => { complete = resolve; });
    };
    const first = s.resumePlayer();
    const second = s.resumePlayer();
    await s.pausePlayer();
    complete({ success: true });
    await Promise.all([first, second]);
    assert.equal(s.getCurrentState().isPlaying, false);
    assert.deepEqual(s.calls, [['resume', false], ['pause']]);
    assert.equal(s.messages.some(m => m.data.resumePlayback), false);
});

test('saved ratings are authoritative and an already liked song is not submitted again', async () => {
    const s = setup();
    s.seed([track('1')]);
    assert.equal(s.getCurrentState().feedback, 'thumbUp');
    await s.thumbUp();
    assert.deepEqual(s.calls, []);
});

test('a failed thumb write does not change the track rating or history', async () => {
    const s = setup();
    s.seed([track()]);
    s.api.addFeedback = async () => ({ success: false });
    assert.equal((await s.thumbUp()).success, false);
    assert.equal(s.getCurrentState().feedback, null);
    assert.equal(s.getCurrentState().history[0].feedback, null);
});

test('undo uses a saved feedback ID and clears confirmed feedback in both track and history', async () => {
    const s = setup();
    s.seed([{ ...track(1), feedbackId: 'saved-feedback' }]);
    const result = await s.handlers.get('PLAYER:UNDO_FEEDBACK')({}, { trackToken: 'track-1' });
    assert.equal(result.success, true);
    assert.deepEqual(s.calls, [['deleteFeedback', 'saved-feedback']]);
    assert.equal(s.getCurrentState().feedback, null);
    assert.equal(s.getCurrentState().history[0].feedback, null);
});

test('an inherited thumb without an undo ID remains highlighted and is not re-added', async () => {
    const s = setup();
    s.seed([track(1)]);
    const result = await s.handlers.get('PLAYER:UNDO_FEEDBACK')({}, { trackToken: 'track-1' });
    assert.equal(result.success, false);
    assert.equal(s.getCurrentState().feedback, 'thumbUp');
    assert.deepEqual(s.calls, []);
});
