const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
function track(rating = 0, token = 'track-1') {
    return { trackToken: token, songRating: rating, songTitle: token, audioURL: 'https://fixture.invalid/' + token };
}

function modes(currentModeId = 0) {
    return { success: true, available: true, currentModeId, modes: [
        { id: 0, name: 'My Station', available: true },
        { id: 1091989, name: 'Energy Boost', available: true },
        { id: 5, name: 'Artist Only', available: false }
    ] };
}

function setup() {
    const handlers = new Map();
    const dialogs = [];
    const messages = [];
    const calls = [];
    const started = [];
    const playlists = [];
    let activeMode = 0;
    const electron = {
        app: { commandLine: { appendSwitch() {} }, on() {}, whenReady: () => new Promise(() => {}) },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        dialog: { showMessageBox: (parent, options) => new Promise(resolve => dialogs.push({ parent, options, resolve })) }
    };
    const api = {
        getPlaylist: async () => playlists.shift() || { tracks: [track()] },
        playbackResumed: async force => { calls.push(['resume', force]); return { success: true }; },
        playbackPaused: async () => { calls.push(['pause']); return true; },
        trackStarted: async (...args) => { started.push(args); },
        getStationModes: async stationId => { calls.push(['getModes', stationId]); return modes(activeMode); },
        setStationMode: async (stationId, modeId) => { calls.push(['setMode', stationId, modeId]); activeMode = modeId; return modes(activeMode); },
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
        module.exports = { playStation, showStreamConflict, getCurrentState, thumbUp, thumbDown, pausePlayer, resumePlayer, loadStationModes, changeStationMode, skipTrack,
            seed: (tracks, station = {}) => { currentStations[0] = { ...currentStations[0], ...station }; currentStation = currentStations[0]; currentPlaylist = tracks; currentTrackIndex = 0; isPaused = false; tracks.forEach(rememberTrack); }
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
    return { ...module.exports, api, handlers, dialogs, messages, calls, started, playlists };
}

test('modes load on request, preserve zero, and reject unavailable or arbitrary selections', async () => {
    const s = setup();
    s.seed([track()]);
    assert.equal(s.getCurrentState().stationModes.status, 'idle');
    assert.deepEqual(s.calls, []);
    assert.equal((await s.changeStationMode('station-1', 1091989)).success, false);
    await s.loadStationModes('station-1');
    assert.equal(s.getCurrentState().stationModes.currentModeId, 0);
    for (const id of [5, 2, '1091989']) {
        assert.equal((await s.changeStationMode('station-1', id)).success, false);
    }
    assert.equal((await s.changeStationMode('station-2', 1091989)).success, false);
    assert.equal((await s.changeStationMode('station-1', 0)).success, true);
    assert.equal(s.calls.filter(c => c[0] === 'setMode').length, 0);
});

test('confirmed tuning immediately plays the first fresh song and resumes previously paused playback', async () => {
    for (const paused of [false, true]) {
        const s = setup();
        s.playlists.push({ tracks: [track(1, 'current'), track(0, 'old-next')] });
        await s.playStation('station-1');
        if (paused) await s.pausePlayer();
        await s.loadStationModes('station-1');
        const requests = [];
        s.api.getPlaylist = async (...args) => {
            requests.push(args);
            return { tracks: [track(1, 'tuned-next'), track(0, 'tuned-2'), track(0, 'tuned-3')] };
        };
        assert.equal((await s.changeStationMode('station-1', 1091989)).success, true);
        assert.deepEqual(requests, [['station-1', false]]);
        assert.equal(s.getCurrentState().trackToken, 'tuned-next');
        assert.equal(s.getCurrentState().feedback, 'thumbUp');
        assert.equal(s.getCurrentState().isPlaying, true);
        assert.deepEqual(s.calls.filter(call => call[0] === 'resume'), paused ? [['resume', false]] : []);
        assert.deepEqual(Array.from(s.getCurrentState().history, item => [item.trackToken, item.feedback]), [
            ['current', 'liked'], ['tuned-next', 'liked']
        ]);
        assert.deepEqual(s.started, [['station-1', 'current'], ['station-1', 'tuned-next']]);
        assert.equal(s.getCurrentState().stationModes.currentModeId, 1091989);
        await s.skipTrack();
        assert.equal(s.getCurrentState().trackToken, 'tuned-2');
        assert.equal(s.getCurrentState().feedback, null);
    }
});

test('a paused mode change waits for resume approval and respects a later pause', async () => {
    for (const pauseAgain of [false, true]) {
        const s = setup();
        s.seed([track(1, 'current')]);
        await s.pausePlayer();
        await s.loadStationModes('station-1');
        s.api.getPlaylist = async () => ({ tracks: [track(0, 'new')] });
        let approve;
        s.api.playbackResumed = async force => {
            s.calls.push(['resume', force]);
            return new Promise(resolve => { approve = resolve; });
        };
        const changing = s.changeStationMode('station-1', 1091989);
        await tick();
        assert.equal(s.getCurrentState().trackToken, 'current');
        assert.equal(s.getCurrentState().isPlaying, false);
        assert.equal(s.started.length, 0);
        if (pauseAgain) await s.pausePlayer();
        approve({ success: true });
        assert.equal((await changing).success, true);
        assert.equal(s.getCurrentState().trackToken, 'new');
        assert.equal(s.getCurrentState().isPlaying, !pauseAgain);
        assert.deepEqual(s.calls.filter(call => call[0] === 'resume'), [['resume', false]]);
        assert.equal(s.calls.filter(call => call[0] === 'pause').length, pauseAgain ? 2 : 1);
    }
});

test('failed mode changes and denied resumes leave an already paused song untouched', async () => {
    for (const resumeDenied of [false, true]) {
        const s = setup();
        s.seed([track(1, 'current')]);
        await s.pausePlayer();
        await s.loadStationModes('station-1');
        if (!resumeDenied) s.api.setStationMode = async () => ({ ...modes(0), success: false, error: 'Mode rejected' });
        s.api.getPlaylist = async () => ({ tracks: [track(0, 'new')] });
        s.api.playbackResumed = async force => { s.calls.push(['resume', force]); return { success: false, error: 'Resume rejected' }; };
        assert.equal((await s.changeStationMode('station-1', 1091989)).success, false);
        assert.equal(s.getCurrentState().trackToken, 'current');
        assert.equal(s.getCurrentState().isPlaying, false);
        assert.equal(s.getCurrentState().feedback, 'thumbUp');
        assert.equal(s.started.length, 0);
        assert.deepEqual(s.calls.filter(call => call[0] === 'resume'), resumeDenied ? [['resume', false]] : []);
    }
});

test('resuming through a mode change still asks before device takeover', async () => {
    const s = setup();
    s.seed([track(1, 'current')]);
    await s.pausePlayer();
    await s.loadStationModes('station-1');
    s.api.getPlaylist = async () => ({ tracks: [track(0, 'new')] });
    s.api.playbackResumed = async force => { s.calls.push(['resume', force]); return { success: false, streamConflict: true }; };
    const changing = s.changeStationMode('station-1', 1091989);
    await tick();
    assert.equal(s.dialogs.length, 1);
    assert.equal(s.getCurrentState().streamBlocked, true);
    assert.deepEqual(s.calls.filter(call => call[0] === 'resume'), [['resume', false]]);
    s.dialogs[0].resolve({ response: 1 });
    await changing;
    assert.equal(s.getCurrentState().isPlaying, false);
    assert.equal(s.started.length, 0);
});

test('late mode resume approvals cannot play after switching stations or signing out', async () => {
    for (const logout of [false, true]) {
        const s = setup();
        s.seed([track(1, 'current')]);
        await s.pausePlayer();
        await s.loadStationModes('station-1');
        s.api.getPlaylist = async stationId => ({ tracks: [track(0, stationId === 'station-1' ? 'new' : 'other')] });
        let approve;
        s.api.playbackResumed = async () => new Promise(resolve => { approve = resolve; });
        const changing = s.changeStationMode('station-1', 1091989);
        await tick();
        if (logout) await s.handlers.get('AUTH:LOGOUT')();
        else await s.playStation('station-2');
        approve({ success: true });
        await changing;
        assert.equal(s.getCurrentState().trackToken, logout ? null : 'other');
        assert.equal(s.started.some(call => call[1] === 'new'), false);
    }
});

test('an empty, failed or unplayable fresh playlist leaves the current song and thumb untouched', async () => {
    for (const playlist of [{ tracks: [] }, { tracks: [track(0, 'new')], error: 'Offline' },
        { tracks: [{ trackToken: 'no-audio' }] }]) {
        const s = setup();
        s.seed([track(1, 'current')]);
        await s.loadStationModes('station-1');
        s.api.getPlaylist = async () => playlist;
        assert.equal((await s.changeStationMode('station-1', 1091989)).success, false);
        assert.equal(s.getCurrentState().trackToken, 'current');
        assert.equal(s.getCurrentState().feedback, 'thumbUp');
        assert.equal(s.getCurrentState().isPlaying, true);
        assert.equal(s.getCurrentState().stationModes.currentModeId, 1091989);
        assert.ok(s.getCurrentState().stationModes.error);
        assert.equal(s.started.length, 0);
    }
});

test('a confirmed mode can start its first song when the station had no current track', async () => {
    const s = setup();
    s.seed([]);
    await s.loadStationModes('station-1');
    s.api.getPlaylist = async () => ({ tracks: [track(0, 'first'), track(0, 'second')] });
    await s.changeStationMode('station-1', 1091989);
    assert.equal(s.getCurrentState().trackToken, 'first');
});

test('a mode switch waits for read-back confirmation and never undoes a pause while waiting', async () => {
    const s = setup();
    s.seed([track(1, 'current')]);
    await s.loadStationModes('station-1');
    let confirm;
    s.api.getStationModes = async () => new Promise(resolve => { confirm = resolve; });
    s.api.getPlaylist = async () => ({ tracks: [track(0, 'new')] });
    const changing = s.changeStationMode('station-1', 1091989);
    await tick();
    assert.equal(s.getCurrentState().trackToken, 'current');
    assert.equal(s.getCurrentState().stationModes.currentModeId, 0);
    await s.pausePlayer();
    confirm(modes(1091989));
    await changing;
    assert.equal(s.getCurrentState().trackToken, 'new');
    assert.equal(s.getCurrentState().isPlaying, false);
});

test('Shuffle is identified from metadata or its endpoint and never requests station modes', async () => {
    for (const metadata of [{ isShuffle: true }, { isQuickMix: true }, { stationType: 'QUICKMIX' }, { name: 'QuickMix' }]) {
        const s = setup();
        s.seed([track()], metadata);
        assert.equal(s.getCurrentState().isShuffle, true);
        assert.equal((await s.loadStationModes('station-1')).success, false);
        assert.equal((await s.changeStationMode('station-1', 1091989)).success, false);
        assert.equal(s.calls.length, 0);
        await s.playStation('station-2');
        assert.equal(s.getCurrentState().isShuffle, false);
    }
    const s = setup();
    // Even a response without recognizable name/flags must be marked as Shuffle.
    s.api.getShuffleStation = async () => ({ stationId: 'station-1', name: 'A mix' });
    await s.handlers.get('CONTENT:PLAY_SHUFFLE')();
    assert.equal(s.getCurrentState().isShuffle, true);
    assert.equal((await s.loadStationModes('station-1')).success, false);
    assert.equal(s.calls.length, 0);
    assert.equal(s.messages.find(m => m.name === 'UI:COLLECTION_DATA').data[0].isShuffle, true);
});

test('a rejected change and a mode reset during playlist fetch never display the requested mode as active', async () => {
    for (const resetDuringFetch of [false, true]) {
        const s = setup();
        s.seed([track()]);
        await s.loadStationModes('station-1');
        s.api.setStationMode = async () => resetDuringFetch ? modes(1091989) : { ...modes(0), success: false, error: 'Not enabled' };
        s.api.getStationModes = async () => modes(0);
        assert.equal((await s.changeStationMode('station-1', 1091989)).success, false);
        assert.equal(s.getCurrentState().stationModes.currentModeId, 0);
        assert.ok(s.getCurrentState().stationModes.error);
        assert.equal(s.getCurrentState().trackToken, 'track-1');
    }
});

test('lost setter responses read back actual state; failed verification clears the unconfirmed mode', async () => {
    const s = setup();
    s.seed([track()]);
    await s.loadStationModes('station-1');
    s.api.setStationMode = async () => ({ success: false, error: 'Timed out' });
    s.api.getStationModes = async () => modes(1091989);
    assert.equal((await s.changeStationMode('station-1', 1091989)).success, false);
    assert.equal(s.getCurrentState().stationModes.currentModeId, 1091989, 'Read-back is authoritative even after a lost response');
    s.api.setStationMode = async () => modes(0);
    s.api.getStationModes = async () => ({ success: false, error: 'Offline' });
    await s.changeStationMode('station-1', 0);
    assert.equal(s.getCurrentState().stationModes.currentModeId, null);
    assert.equal(s.getCurrentState().stationModes.status, 'error');
    assert.equal(s.getCurrentState().trackToken, 'track-1');
});

test('a delayed pre-change playlist cannot overwrite tuning', async () => {
    const s = setup();
    s.seed([track()]);
    await s.loadStationModes('station-1');
    let oldPlaylist;
    let requests = 0;
    s.api.getPlaylist = async () => ++requests === 1
        ? new Promise(resolve => { oldPlaylist = resolve; })
        : { tracks: [track(0, 'tuned'), track(0, 'tuned-2'), track(0, 'tuned-3')] };
    const pending = s.handlers.get('PLAYER:GET_MORE_TRACKS')();
    await s.changeStationMode('station-1', 1091989);
    oldPlaylist({ tracks: [track(0, 'stale')], streamConflict: true });
    await pending;
    assert.equal(s.dialogs.length, 0);
    assert.equal(s.getCurrentState().playlistLength, 4);
    assert.equal(s.getCurrentState().trackToken, 'tuned');
    await s.skipTrack();
    assert.equal(s.getCurrentState().trackToken, 'tuned-2');
});

test('a song ending waits for tuning; repeated changes and prefetch are blocked while it is pending', async () => {
    const s = setup();
    s.seed([track(1, 'current'), track(0, 'stale-next')]);
    await s.loadStationModes('station-1');
    let complete;
    s.api.setStationMode = async () => new Promise(resolve => { complete = resolve; });
    s.api.getStationModes = async () => modes(1091989);
    s.api.getPlaylist = async () => ({ tracks: [track(0, 'tuned'), track(0, 'tuned-2'), track(0, 'tuned-3')] });
    const changing = s.changeStationMode('station-1', 1091989);
    const ended = s.skipTrack();
    assert.equal(ended, s.skipTrack(), 'Duplicate Next must share the pending advance');
    assert.equal((await s.changeStationMode('station-1', 1091989)).success, false);
    assert.equal((await s.handlers.get('PLAYER:GET_MORE_TRACKS')()).tracks.length, 0);
    assert.equal(s.getCurrentState().stationModes.currentModeId, 0);
    assert.equal(s.getCurrentState().trackToken, 'current');
    await s.pausePlayer();
    complete(modes(1091989));
    await Promise.all([changing, ended]);
    assert.equal(s.getCurrentState().trackToken, 'tuned');
    assert.equal(s.getCurrentState().isPlaying, false, 'A later pause must win');
    assert.deepEqual(s.started, [['station-1', 'tuned']], 'The pending Next must not double-advance');
});

test('station switches and sign-out discard delayed mode reads and changes', async () => {
    for (const readOnly of [false, true]) {
        for (const logout of [false, true]) {
            const s = setup();
            s.seed([track()]);
            let complete;
            let pending;
            if (readOnly) {
                s.api.getStationModes = async () => new Promise(resolve => { complete = resolve; });
                pending = s.loadStationModes('station-1');
            } else {
                await s.loadStationModes('station-1');
                s.api.setStationMode = async () => new Promise(resolve => { complete = resolve; });
                pending = s.changeStationMode('station-1', 1091989);
            }
            if (logout) await s.handlers.get('AUTH:LOGOUT')();
            else await s.playStation('station-2');
            complete(modes(1091989));
            await pending;
            assert.equal(s.getCurrentState().stationId, logout ? null : 'station-2');
            assert.equal(s.getCurrentState().stationModes.status, 'idle');
            assert.equal(s.getCurrentState().stationModes.currentModeId, null);
            assert.equal(s.getCurrentState().stationModes.changing, false);
        }
    }
});

test('mode change conflicts retain the explicit device choice and reset tuning after takeover', async () => {
    for (const response of [0, 1]) {
        const s = setup();
        s.seed([track()]);
        await s.loadStationModes('station-1');
        s.api.setStationMode = async () => ({ success: false, streamConflict: true });
        const pending = s.changeStationMode('station-1', 1091989);
        await tick();
        assert.equal(s.dialogs.length, 1);
        assert.equal(s.calls.some(c => c[0] === 'resume'), false);
        assert.equal(s.getCurrentState().streamBlocked, true);
        s.dialogs[0].resolve({ response });
        await pending;
        assert.equal(s.getCurrentState().streamBlocked, response !== 0);
        if (response === 0) assert.equal(s.getCurrentState().stationModes.status, 'idle');
    }
});

test('a pending skip cannot advance the song or append its queue after tuning starts', async () => {
    const s = setup();
    s.seed([track(1, 'current'), track(0, 'stale')]);
    await s.loadStationModes('station-1');
    let oldResult;
    let count = 0;
    s.api.getPlaylist = async () => ++count === 1
        ? new Promise(resolve => { oldResult = resolve; })
        : { tracks: [track(0, 'tuned'), track(0, 'tuned-2'), track(0, 'tuned-3')] };
    const oldSkip = s.skipTrack();
    assert.equal(s.getCurrentState().trackToken, 'current');
    await s.changeStationMode('station-1', 1091989);
    oldResult({ tracks: [track(0, 'old-fetch')] });
    await oldSkip;
    assert.equal(s.getCurrentState().trackToken, 'tuned');
    await s.skipTrack();
    assert.equal(s.getCurrentState().trackToken, 'tuned-2');
});

test('a delayed thumbs-down updates the old song without skipping the new mode’s first song', async () => {
    const s = setup();
    s.seed([track(0, 'current')]);
    await s.loadStationModes('station-1');
    let finishFeedback;
    s.api.addFeedback = async () => new Promise(resolve => { finishFeedback = resolve; });
    const thumb = s.thumbDown();
    s.api.getPlaylist = async () => ({ tracks: [track(0, 'tuned'), track(0, 'tuned-2'), track(0, 'tuned-3')] });
    await s.changeStationMode('station-1', 1091989);
    finishFeedback({ success: true, feedbackId: 'new-thumb' });
    await thumb;
    assert.equal(s.getCurrentState().trackToken, 'tuned');
    assert.equal(s.getCurrentState().history[0].feedback, 'disliked');
    assert.deepEqual(s.started, [['station-1', 'tuned']]);
});

test('a skip conflict followed by takeover releases the queue refill guard', async () => {
    const s = setup();
    s.seed([track()]);
    s.playlists.push({ tracks: [], streamConflict: true }, { tracks: [track(0, 'reclaimed')] });
    const skip = s.skipTrack();
    await tick();
    s.dialogs[0].resolve({ response: 0 });
    await skip;
    s.playlists.push({ tracks: [track(0, 'next-after-takeover')] });
    await s.skipTrack();
    assert.equal(s.getCurrentState().trackToken, 'next-after-takeover');
});

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

test('a late pre-takeover playlist conflict cannot stop successfully reclaimed playback', async () => {
    const s = setup();
    s.seed([track()]);
    let finishOldRequest;
    let requests = 0;
    s.api.getPlaylist = async () => {
        if (++requests === 1) return new Promise(resolve => { finishOldRequest = resolve; });
        return { tracks: [track(1, 'reclaimed-track')] };
    };
    const oldRequest = s.handlers.get('PLAYER:GET_MORE_TRACKS')();
    const choice = s.showStreamConflict('station-1');
    s.dialogs[0].resolve({ response: 0 });
    await choice;
    finishOldRequest({ tracks: [], streamConflict: true });
    await tick();
    // Clean up the unexpected dialog on the unfixed implementation before asserting.
    if (s.dialogs[1]) s.dialogs[1].resolve({ response: 1 });
    await oldRequest;
    assert.equal(s.dialogs.length, 1);
    assert.equal(s.getCurrentState().trackToken, 'reclaimed-track');
    assert.equal(s.getCurrentState().isPlaying, true);
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

test('a conflict on the newly selected station gets its own choice after an old popup closes', async () => {
    const s = setup();
    s.seed([track()]);
    const oldPrompt = s.showStreamConflict('station-1');
    s.playlists.push({ tracks: [], streamConflict: true }, { tracks: [track(1)] });
    const nextStation = s.playStation('station-2');
    await tick();
    s.dialogs[0].resolve({ response: 0 });
    await oldPrompt;
    await tick();
    assert.deepEqual(s.calls, [], 'The old choice must not reclaim the new station');
    assert.equal(s.dialogs.length, 2);
    s.dialogs[1].resolve({ response: 0 });
    await nextStation;
    assert.equal(s.getCurrentState().stationId, 'station-2');
    assert.equal(s.getCurrentState().isPlaying, true);
    assert.deepEqual(s.calls, [['resume', true]]);
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

test('REST playlist ratings highlight historical likes on first load and skip without re-submitting', async () => {
    const s = setup();
    const restTrack = (rating, token) => {
        const item = track(0, token);
        delete item.songRating;
        return { ...item, rating };
    };
    s.playlists.push({ tracks: [restTrack(1, 'rest-1'), restTrack('1', 'rest-2'), restTrack(0, 'rest-3')] });
    await s.playStation('station-1');
    assert.equal(s.getCurrentState().feedback, 'thumbUp');
    assert.equal(s.getCurrentState().history[0].feedback, 'liked');
    await s.thumbUp();
    await s.handlers.get('PLAYER:CMD')({}, { action: 'next' });
    assert.equal(s.getCurrentState().feedback, 'thumbUp');
    assert.equal(s.getCurrentState().history[1].feedback, 'liked');
    await s.thumbUp();
    assert.deepEqual(s.calls, []);
});

test('REST rating takes precedence over the legacy field and confirmed undo clears both', async () => {
    const s = setup();
    s.seed([{ ...track(1), rating: -1, feedbackId: 'rest-feedback' }]);
    assert.equal(s.getCurrentState().feedback, 'thumbDown');
    assert.equal(s.getCurrentState().history[0].feedback, 'disliked');
    const result = await s.handlers.get('PLAYER:UNDO_FEEDBACK')({}, { trackToken: 'track-1' });
    assert.equal(result.success, true);
    assert.equal(s.getCurrentState().feedback, null);
    await s.thumbUp();
    assert.equal(s.getCurrentState().feedback, 'thumbUp');
    assert.deepEqual(s.calls, [['deleteFeedback', 'rest-feedback'], ['addFeedback']]);
});

test('a failed write preserves a saved REST rating and its history', async () => {
    const s = setup();
    s.seed([{ ...track(0), rating: 1, feedbackId: 'rest-feedback' }]);
    s.api.addFeedback = async () => ({ success: false });
    s.api.deleteFeedback = async () => ({ success: false });
    assert.equal((await s.thumbDown()).success, false);
    assert.equal((await s.handlers.get('PLAYER:UNDO_FEEDBACK')({}, { trackToken: 'track-1' })).success, false);
    assert.equal(s.getCurrentState().feedback, 'thumbUp');
    assert.equal(s.getCurrentState().history[0].feedback, 'liked');
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
