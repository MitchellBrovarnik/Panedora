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

function setup(config = { getRememberedShuffle: () => null, rememberShuffle() {} }) {
    const handlers = new Map();
    const prompts = [];
    const messages = [];
    const calls = [];
    const started = [];
    const playlists = [];
    let activeMode = 0;
    const electron = {
        app: { isPackaged: true, commandLine: { appendSwitch() {} }, on() {}, whenReady: () => new Promise(() => {}) },
        shell: { openExternal: async url => { calls.push(['openExternal', url]); } },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) }
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
    const window = { isDestroyed: () => false, webContents: { send: (name, data) => {
        messages.push({ name, data });
        if (name === 'UI:PLAYER_STATE' && data.streamPrompt && !prompts.some(p => p.id === data.streamPrompt.id)) {
            const id = data.streamPrompt.id;
            prompts.push({ id, choose: takeOver => handlers.get('PLAYER:RESOLVE_STREAM_CONFLICT')(
                { sender: window.webContents }, { promptId: id, takeOver }) });
        }
    } } };
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8') + `
        api = testApi;
        uiWindow = testWindow;
        currentStations = [{stationId:'station-1'}, {stationId:'station-2'}];
        module.exports = { loadStations, playStation, showStreamConflict, getCurrentState, thumbUp, thumbDown, pausePlayer, resumePlayer, loadStationModes, changeStationMode, skipTrack,
            seedUpdateChecker: checker => { updateChecker = checker; },
            seedDiscord: presence => { discordPresence = presence; discordPresence.setPlayerState(getCurrentState()); },
            seed: (tracks, station = {}) => { currentStations[0] = { ...currentStations[0], ...station }; currentStation = currentStations[0]; currentPlaylist = tracks; currentTrackIndex = 0; isPaused = false; tracks.forEach(rememberTrack); }
        };`;
    vm.runInNewContext(source, {
        module, testApi: api, testWindow: window,
        require: name => {
            if (name === 'electron') return electron;
            if (name === './pandora-api') return { getHighResArt: () => null, getArtUrls: () => [] };
            if (name === './update-checker') return require('../update-checker');
            if (name === './discord-presence') return require('../discord-presence');
            if (name === './discord-config.json') return require('../discord-config.json');
            if (name === './config') return config;
            if (name === './pandora-verification') return { PandoraVerification: class { cancel() {} } };
            return require(name);
        },
        __dirname: path.join(__dirname, '..'), process,
        setTimeout, clearTimeout,
        console: { log() {}, error() {} }
    });
    return { ...module.exports, api, handlers, prompts, window, messages, calls, started, playlists, electron };
}

test('update checks and choices require the app renderer and a verified notice', async () => {
    const s = setup();
    const checker = {
        notice: { version: '1.2.0', currentVersion: '1.1.3' },
        check: async () => checker.notice,
        dismiss: version => { assert.equal(version, checker.notice.version); checker.notice = null; return true; }
    };
    s.seedUpdateChecker(checker);
    const trusted = { sender: s.window.webContents };
    const check = s.handlers.get('APP:CHECK_UPDATES');
    assert.equal(await check({ sender: {} }), null);
    s.electron.app.isPackaged = false;
    assert.equal(await check(trusted), null, 'Development launches must not check for updates');
    s.electron.app.isPackaged = true;
    assert.equal((await check(trusted)).version, '1.2.0');
    const answer = s.handlers.get('APP:UPDATE_RESPONSE');
    for (const [event, payload] of [
        [{ sender: {} }, { version: '1.2.0', action: 'download' }],
        [trusted, { version: '9.0.0', action: 'download' }],
        [trusted, { version: '1.2.0', action: 'https://untrusted.invalid' }]
    ]) assert.equal((await answer(event, payload)).success, false);
    assert.deepEqual(s.calls, []);
    assert.equal((await answer(trusted, { version: '1.2.0', action: 'download', url: 'https://untrusted.invalid' })).success, true);
    assert.deepEqual(s.calls, [['openExternal', 'https://github.com/MitchellBrovarnik/Panedora/releases/latest']]);
    assert.equal((await answer(trusted, { version: '1.2.0', action: 'download' })).success, false);
});

test('Discord IPC is limited to the app main frame and logout clears before network work', async () => {
    const saved = [];
    const s = setup({ setDiscordEnabled: value => saved.push(value) });
    s.seed([track()]);
    const updates = [];
    const reports = [];
    const presence = {
        configured: true,
        getStatus: () => ({ enabled: false, configured: true, status: 'disabled' }),
        setPlayerState: state => updates.push(state),
        setEnabled: enabled => ({ enabled }),
        reportPlayback: value => { reports.push(value); return true; }
    };
    s.seedDiscord(presence);
    const event = { sender: s.window.webContents };
    const set = s.handlers.get('DISCORD:SET_ENABLED');
    const report = s.handlers.get('DISCORD:PLAYBACK');
    assert.equal(set({ sender: {} }, true), null);
    assert.equal(set({ ...event, senderFrame: {} }, true), null);
    assert.equal(set(event, 'true'), null);
    assert.equal(report({ sender: {} }, {}), false);
    assert.equal(report({ ...event, senderFrame: {} }, {}), false);
    assert.deepEqual(saved, []); assert.deepEqual(reports, []);
    presence.configured = false;
    set(event, true); assert.deepEqual(saved, []);
    presence.configured = true;
    assert.equal(set(event, true).enabled, true);
    assert.deepEqual(saved, [true]);
    let finish;
    s.api.playbackPaused = () => new Promise(resolve => { finish = resolve; });
    const logout = s.handlers.get('AUTH:LOGOUT')();
    assert.equal(updates.at(-1), null, 'Clear even if Pandora pause stalls');
    finish(); await logout;
});

test('update download failures allow retry and duplicate clicks cannot open multiple browser tabs', async () => {
    const s = setup();
    const checker = { notice: { version: '1.2.0' }, dismiss: () => { checker.notice = null; return true; } };
    s.seedUpdateChecker(checker);
    const answer = s.handlers.get('APP:UPDATE_RESPONSE');
    const event = { sender: s.window.webContents };
    const choice = { version: '1.2.0', action: 'download' };
    s.electron.shell.openExternal = async () => { throw new Error('No browser'); };
    assert.match((await answer(event, choice)).error, /Could not open/);
    assert.ok(checker.notice);
    let finish;
    let opened = 0;
    s.electron.shell.openExternal = () => { opened++; return new Promise(resolve => { finish = resolve; }); };
    const pending = answer(event, choice);
    assert.equal((await answer(event, choice)).success, false);
    assert.equal(opened, 1);
    finish();
    assert.equal((await pending).success, true);
    assert.equal(checker.notice, null);
});

test('Later saves the update choice without opening a browser or changing playback', async () => {
    const s = setup();
    const checker = { notice: { version: '1.2.0' }, dismiss: () => { checker.notice = null; return true; } };
    s.seedUpdateChecker(checker);
    s.seed([track()]);
    const before = s.getCurrentState();
    const result = await s.handlers.get('APP:UPDATE_RESPONSE')({ sender: s.window.webContents }, { version: '1.2.0', action: 'later' });
    assert.equal(result.success, true);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.getCurrentState(), before);
});

test('Shuffle survives a new app session and collection refreshes when Pandora omits it', async () => {
    let remembered = null;
    const config = { getRememberedShuffle: () => remembered && { ...remembered }, rememberShuffle: station => { remembered = { ...station }; } };
    const first = setup(config);
    first.api.getShuffleStation = async () => ({ stationId: 'shuffle-1', name: 'My Mix', lastPlayed: '2020-01-01T00:00:00.000Z' });
    await first.handlers.get('CONTENT:PLAY_SHUFFLE')();
    assert.equal(remembered.isShuffle, true);
    assert.ok(new Date(remembered.lastPlayed) > new Date('2020-01-01'));

    const restarted = setup(config);
    restarted.api.getStations = async () => [{ stationId: 'station-1', name: 'First Radio' }];
    for (let i = 0; i < 2; i++) {
        await restarted.loadStations();
        const collection = restarted.messages.filter(message => message.name === 'UI:COLLECTION_DATA').at(-1).data;
        assert.deepEqual(Array.from(collection, station => station.id), ['station-1', 'shuffle-1']);
        assert.equal(collection[1].isShuffle, true);
        assert.equal(collection[1].lastUpdated, remembered.lastPlayed);
    }
    assert.equal(restarted.getCurrentState().isPlaying, false, 'Restoring Home must not start playback');
    assert.equal(restarted.started.length, 0);
});

test('restored Shuffle cards resolve a fresh station and do not duplicate a server QuickMix entry', async () => {
    let remembered = { stationId: 'old-shuffle', isShuffle: true, lastPlayed: '2025-01-01T00:00:00.000Z' };
    const config = { getRememberedShuffle: () => ({ ...remembered }), rememberShuffle: station => { remembered = { ...station }; } };
    const s = setup(config);
    s.api.getStations = async () => [{ stationId: 'station-1' }, { stationId: 'server-shuffle', stationType: 'QUICKMIX', lastPlayed: '2020-01-01T00:00:00.000Z' }];
    await s.loadStations();
    assert.equal(remembered.stationId, 'server-shuffle');
    assert.equal(remembered.lastPlayed, '2025-01-01T00:00:00.000Z');
    const collection = () => s.messages.filter(message => message.name === 'UI:COLLECTION_DATA').at(-1).data;
    assert.equal(collection().filter(station => station.isShuffle).length, 1);
    let shuffleRequests = 0;
    const playlistRequests = [];
    s.api.getShuffleStation = async () => { shuffleRequests++; return { stationId: 'fresh-shuffle', name: 'Fresh Mix' }; };
    s.api.getPlaylist = async id => { playlistRequests.push(id); return { tracks: [track()] }; };
    await s.handlers.get('NAV:PLAY_URI')({}, { uri: 'station:server-shuffle' });
    assert.equal(shuffleRequests, 1);
    assert.deepEqual(playlistRequests, ['fresh-shuffle']);
    assert.equal(s.getCurrentState().isShuffle, true);
    assert.equal(remembered.stationId, 'fresh-shuffle');
    assert.deepEqual(Array.from(collection().filter(station => station.isShuffle), station => station.id), ['fresh-shuffle']);
    s.api.getShuffleStation = async () => null;
    assert.ok((await s.handlers.get('CONTENT:PLAY_SHUFFLE')()).error);
    assert.equal(remembered.stationId, 'fresh-shuffle', 'A failed request preserves the remembered entry');
});

test('a delayed Shuffle response cannot restore its card or start playback after logout', async () => {
    let remembered = null;
    const s = setup({ getRememberedShuffle: () => remembered, rememberShuffle: station => { remembered = station; } });
    let finish;
    s.api.getShuffleStation = () => new Promise(resolve => { finish = resolve; });
    const pending = s.handlers.get('CONTENT:PLAY_SHUFFLE')();
    await s.handlers.get('AUTH:LOGOUT')();
    finish({ stationId: 'old-account-shuffle' });
    await pending;
    assert.equal(remembered, null);
    assert.equal(s.getCurrentState().stationId, null);
    assert.equal(s.started.length, 0);
});

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

test('a paused mode change waits for approval and starts the new song regardless of pauses on the old song', async () => {
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
        assert.equal(s.getCurrentState().isPlaying, true);
        assert.deepEqual(s.calls.filter(call => call[0] === 'resume'), [['resume', false]]);
        assert.equal(s.calls.filter(call => call[0] === 'pause').length, 1);
        await s.pausePlayer();
        assert.equal(s.getCurrentState().isPlaying, false, 'Pause applies normally to the new song');
        assert.equal(s.getCurrentState().trackToken, 'new');
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

test('Play during a mode change waits for the new song instead of resuming the old one in parallel', async () => {
    const s = setup();
    s.seed([track(1, 'current')]);
    await s.pausePlayer();
    await s.loadStationModes('station-1');
    let finishMode;
    const resumes = [];
    s.api.setStationMode = async () => new Promise(resolve => { finishMode = resolve; });
    s.api.getStationModes = async () => modes(1091989);
    s.api.getPlaylist = async () => ({ tracks: [track(0, 'new')] });
    s.api.playbackResumed = async force => new Promise(resolve => { resumes.push({ force, resolve }); });
    const changing = s.changeStationMode('station-1', 1091989);
    const play = s.resumePlayer();
    await tick();
    const prematureResumes = resumes.length;
    finishMode(modes(1091989));
    await tick();
    for (const resume of resumes) resume.resolve({ success: true });
    await Promise.all([changing, play]);
    assert.equal(prematureResumes, 0, 'Play must not resume the old song while its replacement is loading');
    assert.deepEqual(resumes.map(resume => resume.force), [false], 'Mode switching owns one normal resume request');
    assert.equal(s.getCurrentState().trackToken, 'new');
    assert.equal(s.getCurrentState().isPlaying, true);
});

test('a Next queued during a failed mode resume cannot start unapproved audio', async () => {
    const s = setup();
    s.seed([track(1, 'current')]);
    await s.pausePlayer();
    await s.loadStationModes('station-1');
    s.api.getPlaylist = async () => ({ tracks: [track(0, 'new')] });
    let finishResume;
    s.api.playbackResumed = async () => new Promise(resolve => { finishResume = resolve; });
    const changing = s.changeStationMode('station-1', 1091989);
    await tick();
    const next = s.skipTrack();
    finishResume({ success: false, error: 'Resume denied' });
    await Promise.all([changing, next]);
    assert.equal(s.getCurrentState().trackToken, 'current');
    assert.equal(s.getCurrentState().isPlaying, false);
    assert.equal(s.started.length, 0);
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
    assert.equal(s.prompts.length, 1);
    assert.equal(s.getCurrentState().streamBlocked, true);
    assert.deepEqual(s.calls.filter(call => call[0] === 'resume'), [['resume', false]]);
    s.prompts[0].choose(false);
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

test('a mode switch waits for confirmation and starts the new song even if the old song was paused while waiting', async () => {
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
    assert.equal(s.getCurrentState().isPlaying, true);
    assert.deepEqual(s.calls.filter(call => call[0] === 'resume'), [['resume', false]]);
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

test('lost setter responses recover from confirmed read-back; failed verification clears the unconfirmed mode', async () => {
    const s = setup();
    s.seed([track()]);
    await s.loadStationModes('station-1');
    s.api.setStationMode = async () => ({ success: false, error: 'Timed out' });
    s.api.getStationModes = async () => modes(1091989);
    s.api.getPlaylist = async () => ({ tracks: [track(0, 'recovered-mode-song')] });
    assert.equal((await s.changeStationMode('station-1', 1091989)).success, true);
    assert.equal(s.getCurrentState().stationModes.currentModeId, 1091989, 'Read-back is authoritative even after a lost response');
    assert.equal(s.getCurrentState().trackToken, 'recovered-mode-song');
    assert.equal(s.getCurrentState().stationModes.error, null);
    s.api.setStationMode = async () => modes(0);
    s.api.getStationModes = async () => ({ success: false, error: 'Offline' });
    await s.changeStationMode('station-1', 0);
    assert.equal(s.getCurrentState().stationModes.currentModeId, null);
    assert.equal(s.getCurrentState().stationModes.status, 'error');
    assert.equal(s.getCurrentState().trackToken, 'recovered-mode-song');
});

test('mode read-back cannot start a song when station or account eligibility is revoked', async () => {
    for (const lostSetter of [false, true]) {
        for (const stationUnavailable of [false, true]) {
            const s = setup();
            s.seed([track()]);
            await s.loadStationModes('station-1');
            s.pausePlayer();
            const revoked = modes(1091989);
            if (stationUnavailable) revoked.available = false;
            else revoked.modes.find(mode => mode.id === 1091989).available = false;
            s.api.setStationMode = async () => lostSetter
                ? { success: false, error: 'Subscription verification failed' }
                : modes(1091989);
            s.api.getStationModes = async () => revoked;
            let playlists = 0;
            s.api.getPlaylist = async () => {
                playlists++;
                return { tracks: [track(0, 'unavailable-mode-song')] };
            };
            assert.equal((await s.changeStationMode('station-1', 1091989)).success, false);
            assert.equal(s.getCurrentState().trackToken, 'track-1');
            assert.equal(s.getCurrentState().isPlaying, false);
            assert.equal(s.started.length, 0);
            assert.equal(playlists, lostSetter ? 0 : 1);
            assert.ok(s.getCurrentState().stationModes.error);
        }
    }
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
    assert.equal(s.prompts.length, 0);
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
    assert.equal(s.getCurrentState().isPlaying, true, 'Completing the mode change starts the new song');
    assert.deepEqual(s.started, [['station-1', 'tuned']], 'The pending Next must not double-advance');
});

test('station switches and sign-out discard delayed mode reads and changes', async () => {
    for (const readOnly of [false, true]) {
        for (const logout of [false, true]) {
            const s = setup();
            s.seed([track()]);
            let complete;
            let pending;
            let isCurrent;
            if (readOnly) {
                s.api.getStationModes = async () => new Promise(resolve => { complete = resolve; });
                pending = s.loadStationModes('station-1');
            } else {
                await s.loadStationModes('station-1');
                s.api.setStationMode = async (stationId, modeId, options) => {
                    isCurrent = options.isCurrent;
                    return new Promise(resolve => { complete = resolve; });
                };
                pending = s.changeStationMode('station-1', 1091989);
                assert.equal(isCurrent(), true);
            }
            if (logout) await s.handlers.get('AUTH:LOGOUT')();
            else await s.playStation('station-2');
            if (!readOnly) assert.equal(isCurrent(), false, 'The API must be able to cancel before submitting the mode');
            complete(modes(1091989));
            await pending;
            assert.equal(s.getCurrentState().stationId, logout ? null : 'station-2');
            assert.equal(s.getCurrentState().stationModes.status, 'idle');
            assert.equal(s.getCurrentState().stationModes.currentModeId, null);
            assert.equal(s.getCurrentState().stationModes.changing, false);
        }
    }
});

test('a mode rejected before submission cannot recover through a matching read-back', async () => {
    const s = setup();
    s.seed([track(1, 'current')]);
    await s.pausePlayer();
    await s.loadStationModes('station-1');
    s.api.setStationMode = async () => ({ success: false, modeRequestSent: false, error: 'Subscription verification failed' });
    s.api.getStationModes = () => assert.fail('No lost-response recovery for a request that was never sent');
    s.api.getPlaylist = () => assert.fail('No fresh playlist for an unverified mode');
    assert.equal((await s.changeStationMode('station-1', 1091989)).success, false);
    assert.equal(s.getCurrentState().trackToken, 'current');
    assert.equal(s.getCurrentState().isPlaying, false);
    assert.equal(s.getCurrentState().stationModes.error, 'Subscription verification failed');
    assert.equal(s.started.length, 0);
});

test('mode change conflicts retain the explicit device choice and reset tuning after takeover', async () => {
    for (const response of [0, 1]) {
        const s = setup();
        s.seed([track()]);
        await s.loadStationModes('station-1');
        s.api.setStationMode = async () => ({ success: false, streamConflict: true });
        const pending = s.changeStationMode('station-1', 1091989);
        await tick();
        assert.equal(s.prompts.length, 1);
        assert.equal(s.calls.some(c => c[0] === 'resume'), false);
        assert.equal(s.getCurrentState().streamBlocked, true);
        s.prompts[0].choose(response === 0);
        await pending;
        assert.equal(s.getCurrentState().streamBlocked, response !== 0);
        if (response === 0) assert.equal(s.getCurrentState().stationModes.status, 'idle');
    }
});

test('a pending skip cannot advance the song or append its queue after tuning starts', async () => {
    const s = setup();
    s.seed([track(1, 'current')]);
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

test('queued songs play immediately while skips share a slow refill, then wait only when empty', async () => {
    const s = setup();
    s.seed([track(1, 'current'), track(0, 'queued-1'), track(0, 'queued-2')]);
    let finish;
    let requests = 0;
    s.api.getPlaylist = () => { requests++; return new Promise(resolve => { finish = resolve; }); };
    const first = s.skipTrack();
    assert.equal(s.getCurrentState().trackToken, 'queued-1', 'A ready song must not wait for the network');
    await first;
    await s.skipTrack();
    assert.equal(s.getCurrentState().trackToken, 'queued-2');
    const empty = s.skipTrack();
    assert.equal(empty, s.skipTrack(), 'Repeated skips while empty share one advance');
    assert.equal(requests, 1);
    finish({ tracks: [track(0, 'fresh-1'), track(0, 'fresh-2')] });
    await empty;
    assert.equal(s.getCurrentState().trackToken, 'fresh-1');
    assert.equal(s.getCurrentState().playlistLength, 5);
});

function recoverAudio(s, expected = s.getCurrentState()) {
    return s.handlers.get('PLAYER:RECOVER_AUDIO')({ sender: s.window.webContents }, expected);
}

test('audio recovery replaces the failed queue, preserves tuning and ignores an older refill', async () => {
    const s = setup();
    s.seed([track()]);
    await s.loadStationModes('station-1');
    await s.changeStationMode('station-1', 1091989);
    s.seed([track(0, 'failed-1'), track(0, 'failed-2'), track(0, 'stale-upcoming')]);
    let finishOld;
    s.api.getPlaylist = () => new Promise(resolve => { finishOld = resolve; });
    await s.skipTrack();
    let finishFresh;
    const requests = [];
    s.api.getPlaylist = (...args) => { requests.push(args); return new Promise(resolve => { finishFresh = resolve; }); };
    const oldGeneration = s.getCurrentState().playbackGeneration;
    const pending = recoverAudio(s);
    assert.equal(s.getCurrentState().stationLoading, true);
    assert.equal(s.getCurrentState().audioRecovery, true);
    assert.equal(s.getCurrentState().playbackGeneration, oldGeneration + 1);
    assert.equal(s.getCurrentState().playlistLength, 2, 'Discard unplayed cached songs');
    assert.equal(pending, recoverAudio(s), 'Duplicate recovery shares the request');
    finishOld({ tracks: [track(0, 'stale-refill')] });
    await tick();
    finishFresh({ tracks: [track(1, 'fresh-1'), track(0, 'fresh-2'), track(0, 'fresh-3')] });
    assert.equal((await pending).success, true);
    assert.equal(s.getCurrentState().trackToken, 'fresh-1');
    assert.equal(s.getCurrentState().feedback, 'thumbUp');
    assert.equal(s.getCurrentState().isPlaying, true);
    assert.equal(s.getCurrentState().stationLoading, false);
    assert.equal(s.getCurrentState().stationModes.currentModeId, 1091989);
    assert.deepEqual(JSON.parse(JSON.stringify(requests)), [['station-1', false]]);
    await s.skipTrack();
    assert.equal(s.getCurrentState().trackToken, 'fresh-2');
    assert.equal(s.getCurrentState().history.some(t => t.trackToken === 'stale-refill'), false);
});

test('audio recovery requires the current app source and active playback intent', async () => {
    const s = setup();
    s.seed([track()]);
    let requests = 0;
    s.api.getPlaylist = async () => { requests++; return { tracks: [track()] }; };
    const current = s.getCurrentState();
    const handler = s.handlers.get('PLAYER:RECOVER_AUDIO');
    for (const [event, expected] of [
        [{ sender: {} }, current],
        [{ sender: s.window.webContents, senderFrame: {} }, current],
        [{ sender: s.window.webContents }, { ...current, playbackGeneration: -1 }],
        [{ sender: s.window.webContents }, { ...current, trackToken: 'old-song' }],
        [{ sender: s.window.webContents }, null]
    ]) assert.equal((await handler(event, expected)).success, false);
    await s.pausePlayer();
    assert.equal((await recoverAudio(s)).success, false);
    assert.equal(requests, 0);
});

test('fresh audio stays paused when the user pauses during recovery', async () => {
    const s = setup();
    s.seed([track()]);
    let finish;
    s.api.getPlaylist = () => new Promise(resolve => { finish = resolve; });
    const pending = recoverAudio(s);
    await s.pausePlayer();
    finish({ tracks: [track(0, 'fresh')] });
    await pending;
    assert.equal(s.getCurrentState().trackToken, 'fresh');
    assert.equal(s.getCurrentState().isPlaying, false);
    assert.deepEqual(s.started, [], 'Do not announce fresh playback while paused');
    await s.resumePlayer();
    assert.equal(s.getCurrentState().isPlaying, true);
    assert.equal(s.calls.some(c => c[0] === 'resume' && c[1] === false), true);
});

test('station changes and logout cancel a pending audio recovery, including a late failure', async () => {
    for (const action of ['station', 'logout']) {
        for (const fails of [false, true]) {
            const s = setup();
            s.seed([track()]);
            let finish;
            s.api.getPlaylist = () => new Promise(resolve => { finish = resolve; });
            const pending = recoverAudio(s);
            if (action === 'station') {
                s.api.getPlaylist = async () => ({ tracks: [track(0, 'different-station')] });
                await s.playStation('station-2');
            } else await s.handlers.get('AUTH:LOGOUT')();
            finish(fails ? { tracks: [], error: 'Old failure' } : { tracks: [track(0, 'late-recovery')] });
            assert.equal((await pending).success, false);
            assert.equal(s.getCurrentState().trackToken, action === 'station' ? 'different-station' : null);
            assert.equal(s.getCurrentState().audioRecovery, false);
            assert.equal(s.getCurrentState().stationLoading, false);
            assert.equal(s.messages.some(m => m.name === 'UI:ERROR'), false);
        }
    }
});

test('a failed fresh playlist stops cleanly without retrying the network forever', async () => {
    for (const failure of ['empty', 'error', 'throw']) {
        const s = setup();
        s.seed([track()]);
        let requests = 0;
        s.api.getPlaylist = async () => {
            requests++;
            if (failure === 'throw') throw new Error('offline');
            return { tracks: [], error: failure === 'error' ? 'offline' : null };
        };
        assert.equal((await recoverAudio(s)).success, false);
        assert.equal(s.getCurrentState().isPlaying, false);
        assert.equal(s.getCurrentState().stationLoading, false);
        assert.equal(requests, 1);
        assert.equal(s.messages.filter(m => m.name === 'UI:ERROR').length, 1);
    }
});

test('audio recovery keeps device takeover subject to the user’s consent', async () => {
    const s = setup();
    s.seed([track()]);
    s.playlists.push({ tracks: [], streamConflict: true });
    const pending = recoverAudio(s);
    await tick();
    assert.equal(s.getCurrentState().streamBlocked, true);
    assert.equal(s.getCurrentState().stationLoading, false);
    assert.equal(s.calls.some(c => c[0] === 'resume'), false);
    s.prompts[0].choose(false);
    await pending;
    assert.equal(s.getCurrentState().isPlaying, false);
    assert.equal(s.calls.some(c => c[0] === 'resume'), false);
});

test('a background refill from the old mode cannot restore its queue after tuning', async () => {
    const s = setup();
    s.seed([track(1, 'current'), track(0, 'queued')]);
    await s.loadStationModes('station-1');
    let finish;
    s.api.getPlaylist = () => new Promise(resolve => { finish = resolve; });
    await s.skipTrack();
    s.api.getPlaylist = async () => ({ tracks: [track(0, 'tuned'), track(0, 'tuned-2')] });
    await s.changeStationMode('station-1', 1091989);
    finish({ tracks: [track(0, 'stale')] });
    await tick();
    assert.equal(s.getCurrentState().trackToken, 'tuned');
    assert.equal(s.getCurrentState().playlistLength, 4);
    assert.equal(s.getCurrentState().history.some(t => t.trackToken === 'stale'), false);
});

test('late end/error commands cannot skip a newer song and an empty queue respects a later pause', async () => {
    const s = setup();
    s.seed([track(0, 'first'), track(0, 'second')]);
    let finish;
    s.api.getPlaylist = () => new Promise(resolve => { finish = resolve; });
    const expected = { trackToken: 'first', playbackGeneration: s.getCurrentState().playbackGeneration };
    await s.handlers.get('PLAYER:CMD')({}, { action: 'next', value: expected });
    assert.equal(s.getCurrentState().trackToken, 'second');
    await s.handlers.get('PLAYER:CMD')({}, { action: 'next', value: expected });
    assert.equal(s.getCurrentState().trackToken, 'second');
    const waiting = s.skipTrack();
    await s.pausePlayer();
    finish({ tracks: [track(0, 'third')] });
    await waiting;
    assert.equal(s.getCurrentState().trackToken, 'third');
    assert.equal(s.getCurrentState().isPlaying, false);
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
    s.prompts[0].choose(true);
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
    assert.equal(s.prompts.length, 1);
    assert.equal(s.getCurrentState().streamBlocked, true);
    assert.equal(s.getCurrentState().audioURL, null);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(JSON.parse(JSON.stringify(s.getCurrentState().streamPrompt)), { id: s.prompts[0].id, pending: false });
    s.prompts[0].choose(false);
    await pending;
    assert.equal(s.getCurrentState().isPlaying, false);
    assert.deepEqual(s.calls, []);
});

test('Let me listen takes over once and loads the new queue with saved feedback', async () => {
    const s = setup();
    s.playlists.push({ tracks: [], streamConflict: true }, { tracks: [track(1)] });
    const pending = s.playStation('station-1');
    await tick();
    s.prompts[0].choose(true);
    await pending;
    assert.deepEqual(s.calls, [['resume', true]]);
    assert.equal(s.getCurrentState().streamBlocked, false);
    assert.equal(s.getCurrentState().isPlaying, true);
    assert.equal(s.getCurrentState().feedback, 'thumbUp');
});

test('in-app takeover requires the current prompt, the app renderer, and an explicit boolean choice', async () => {
    const s = setup();
    s.seed([track()]);
    const pending = s.showStreamConflict('station-1');
    const handler = s.handlers.get('PLAYER:RESOLVE_STREAM_CONFLICT');
    const promptId = s.prompts[0].id;
    for (const [sender, payload] of [
        [{}, { promptId, takeOver: true }],
        [s.window.webContents, { promptId: promptId + 1, takeOver: true }],
        [s.window.webContents, { promptId, takeOver: 'true' }]
    ]) assert.equal(handler({ sender }, payload).success, false);
    assert.equal(s.calls.length, 0);
    assert.equal(s.prompts[0].choose(false).success, true);
    assert.equal(s.prompts[0].choose(true).success, false, 'A answered prompt cannot be reused');
    await pending;
    assert.equal(s.calls.length, 0);
    assert.equal(s.getCurrentState().streamPrompt, null);
    assert.equal(s.getCurrentState().isPlaying, false);
});

test('switching stations cancels the pending in-app prompt without waiting for a response', async () => {
    const s = setup();
    s.seed([track()]);
    const pending = s.showStreamConflict('station-1');
    await s.playStation('station-2');
    await pending;
    assert.equal(s.getCurrentState().streamPrompt, null);
    assert.equal(s.prompts[0].choose(true).success, false);
    assert.equal(s.calls.length, 0);
});

test('concurrent detections share one choice and rejected takeover does not loop', async () => {
    const s = setup();
    s.seed([track()]);
    s.api.playbackResumed = async () => { s.calls.push(['resume', true]); return { success: false, error: 'Still blocked' }; };
    const first = s.showStreamConflict('station-1');
    const second = s.showStreamConflict('station-1');
    assert.equal(first, second);
    assert.equal(s.prompts.length, 1);
    s.prompts[0].choose(true);
    await first;
    assert.equal(s.prompts.length, 1);
    assert.equal(s.getCurrentState().isPlaying, false);
    assert.equal(s.calls.length, 1);
});

test('a repeated playlist conflict after takeover stays paused without another popup', async () => {
    const s = setup();
    s.playlists.push({ tracks: [], streamConflict: true }, { tracks: [], streamConflict: true, error: 'Still blocked' });
    const pending = s.playStation('station-1');
    await tick();
    s.prompts[0].choose(true);
    await pending;
    assert.equal(s.prompts.length, 1);
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
    s.prompts[0].choose(true);
    await choice;
    finishOldRequest({ tracks: [], streamConflict: true });
    await tick();
    // Clean up the unexpected dialog on the unfixed implementation before asserting.
    if (s.prompts[1]) s.prompts[1].choose(false);
    await oldRequest;
    assert.equal(s.prompts.length, 1);
    assert.equal(s.getCurrentState().trackToken, 'reclaimed-track');
    assert.equal(s.getCurrentState().isPlaying, true);
});

test('an old popup cannot reclaim playback after switching stations', async () => {
    const s = setup();
    s.seed([track()]);
    const pending = s.showStreamConflict('station-1');
    await s.playStation('station-2');
    s.prompts[0].choose(true);
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
    s.prompts[0].choose(true);
    await oldPrompt;
    await tick();
    assert.deepEqual(s.calls, [], 'The old choice must not reclaim the new station');
    assert.equal(s.prompts.length, 2);
    s.prompts[1].choose(true);
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
    s.prompts[0].choose(true);
    await pending;
    assert.deepEqual(s.calls, []);
    assert.equal(s.getCurrentState().trackToken, null);
});

test('ordinary playlist errors do not open a device conflict popup', async () => {
    const s = setup();
    s.playlists.push({ tracks: [], error: 'Network error' });
    await s.playStation('station-1');
    assert.equal(s.prompts.length, 0);
    assert.equal(s.getCurrentState().streamBlocked, false);
});

test('normal pause and resume notify Pandora without forcing takeover', async () => {
    const s = setup();
    s.seed([track(1)]);
    await s.pausePlayer();
    await s.pausePlayer();
    await s.resumePlayer();
    assert.deepEqual(s.calls, [['pause'], ['resume', false]]);
    assert.equal(s.prompts.length, 0);
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
