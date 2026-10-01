/**
 * Exercise the real renderer, preload and IPC against local HTTPS fixtures.
 * Dialog choices are controlled by this test; no real account is contacted.
 * Run with: electron tests/electron-player-smoke.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'panedora-player-test-'));
app.setPath('userData', testData);
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Native player test timed out'); app.exit(1); }, 30000);

async function waitFor(check, description) {
    const end = Date.now() + 6000;
    while (!await check()) {
        if (Date.now() > end) throw new Error('Timed out: ' + description);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

// One minute of silence keeps the real audio element playing during assertions.
function silentWav() {
    const samples = 8000 * 60;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    return wav;
}

app.whenReady().then(async () => {
    let canStream = false;
    let resumeGate = null;
    let modeGate = null;
    let activeMode = 0;
    let rejectMode = false;
    let modesUnavailable = false;
    let modesFailed = false;
    let artistOnlyAvailable = false;
    let premiumAccount = false;
    let loseModeResponse = false;
    const modeData = () => ({
        interactiveRadioAvailable: !modesUnavailable,
        currentModeId: activeMode,
        availableModes: modesUnavailable ? [] : [
            { modeId: 0, modeName: 'My Station', modeDescription: 'The station shaped by your thumbs.', isModeAvailable: true },
            { modeId: 1, modeName: 'Crowd Faves', isModeAvailable: true },
            { modeId: 2, modeName: 'Discovery', isModeAvailable: true },
            { modeId: 3, modeName: 'Deep Cuts', isModeAvailable: true },
            { modeId: 4, modeName: 'Newly Released', isModeAvailable: true },
            { modeId: 1091989, modeName: 'Energy Boost', modeDescription: 'A higher-energy mix from this station.', isModeAvailable: true },
            { modeId: 1091990, modeName: 'Relax', isModeAvailable: true },
            { modeId: 5, modeName: 'Artist Only', isModeAvailable: artistOnlyAvailable, isPremiumOnly: true },
            { modeId: 987654, modeName: 'Curated <Mix>', isModeAvailable: true }
        ]
    });
    const calls = [];
    const art = [{ size: 500, url: 'https://fixture.invalid/art.svg' }];
    let fixtureStations = [
        { stationId: 'fixture-station', name: 'Fixture Station', art },
        { stationId: 'removable-station', name: 'Thunder (Live/Acoustic) Radio', art }
    ];
    let removalFailed = false;
    const audio = silentWav();
    const tracks = [1, 2, 3, 4].map(n => ({
        trackToken: 'fixture-track-' + n, songTitle: 'Fixture Song ' + n,
        artistName: 'Fixture Artist', albumTitle: 'Fixture Album', albumArt: art,
        audioURL: 'https://fixture.invalid/audio-' + n + '.wav', trackLength: 60,
        rating: n === 1 ? 1 : n === 2 ? '1' : 0
    }));
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
        status, headers: { 'Content-Type': 'application/json' }
    });
    // Intercept every HTTPS request, including images and the audio fixture.
    session.defaultSession.protocol.handle('https', async request => {
        const url = new URL(request.url);
        if (url.pathname.endsWith('.svg')) return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="#487ad9"/><circle cx="250" cy="250" r="135" fill="#202947"/><circle cx="250" cy="250" r="26" fill="#a5b9f0"/></svg>',
            { headers: { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' } });
        if (url.pathname.endsWith('.wav')) return new Response(audio, {
            headers: { 'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*' }
        });
        const body = request.method === 'POST' ? JSON.parse(await request.text()) : {};
        calls.push({ path: url.pathname, body });
        switch (url.pathname) {
            case '/api/v1/auth/login':
                return json({ authToken: 'fixture-token', config: premiumAccount
                    ? { branding: 'PandoraPremium', flags: ['onDemand'] }
                    : { branding: 'PandoraPlus' } });
            case '/api/v1/station/getStations':
                return json({ stations: fixtureStations });
            case '/api/v1/station/removeStation':
                if (removalFailed) return json({ errorString: 'Removal failed' }, 503);
                fixtureStations = fixtureStations.filter(station => station.stationId !== body.stationId);
                return json({});
            case '/api/v1/station/shuffle':
                return json({ stationId: 'fixture-shuffle', name: 'Fixture Mix', art });
            case '/api/v1/search/fullSearch':
                return json({ items: [{ type: 'TR', pandoraId: 'TR:fixture', songTitle: 'Fixture Song', artistName: 'Fixture Artist', albumArt: art }] });
            case '/api/v1/playlist/getFragment': {
                let playlistTracks = activeMode === 0 ? tracks : tracks.map(t => ({
                    ...t, trackToken: 'tuned-' + activeMode + '-' + t.trackToken,
                    songTitle: 'Tuned ' + t.songTitle, audioURL: t.audioURL.replace('audio-', 'tuned-audio-')
                }));
                if (body.stationId === 'fixture-shuffle') {
                    playlistTracks = playlistTracks.map(t => ({ ...t, trackToken: 'shuffle-' + t.trackToken }));
                }
                return canStream ? json({ tracks: playlistTracks }) : json({ errorString: 'STREAM_VIOLATION' }, 429);
            }
            case '/api/v1/interactiveradio/getAvailableModesSimple':
                return modesFailed ? json({ errorString: 'Unavailable' }, 503) : json(modeData());
            case '/api/v1/interactiveradio/setAndGetAvailableModes':
                if (modeGate) await modeGate;
                if (!rejectMode) activeMode = body.modeId;
                if (loseModeResponse) return json({ errorString: 'Response lost after applying mode' }, 504);
                return json(modeData());
            case '/api/v1/station/playbackResumed':
                if (body.forceActive) canStream = true;
                else if (resumeGate) await resumeGate;
                return canStream ? json({}) : json({ errorString: 'STREAM_VIOLATION' }, 429);
            case '/api/v1/station/playbackPaused':
            case '/api/v1/station/trackStarted':
                return json({});
            case '/api/v1/station/addFeedback':
                return json({ feedbackId: 'fixture-feedback' });
            default:
                return new Response('Unexpected fixture URL', { status: 404 });
        }
    });

    require('../main');
    await waitFor(() => BrowserWindow.getAllWindows().length, 'main window');
    const win = BrowserWindow.getAllWindows()[0];
    const run = script => win.webContents.executeJavaScript(script, true);
    const capture = async name => {
        // Wait for entry animations and a compositor frame, not just DOM changes.
        await run('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 500))');
        fs.writeFileSync(path.join(testData, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    await waitFor(() => run("!!document.getElementById('login-form')"), 'login UI');
    assert.equal((await run("window.api.auth.login('fixture@example.invalid', 'fixture-password')")).success, true);
    await waitFor(() => run('AppState.stations.length === 2'), 'station collection');

    await run("AppState.searchQuery = 'fixture'; renderPage('search'); window.api.content.search('fixture')");
    await waitFor(() => run("document.querySelector('#search-songs img')?.naturalWidth > 0"), 'search artwork');
    assert.equal(await run("document.querySelector('#search-songs img').src"), art[0].url);
    await run("document.querySelectorAll('.error-toast').forEach(toast => toast.remove())");
    await capture('search-artwork');

    await run("void window.api.content.playItem({type:'station', id:'fixture-station'})");
    await waitFor(() => run("document.getElementById('stream-conflict-dialog').open"), 'first listening choice');
    assert.equal(await run("document.activeElement.id"), 'stream-keep-listening');
    assert.equal(await run("document.querySelector('.station-item.active')?.dataset.id"), 'fixture-station');
    await capture('device-takeover');
    const savedTakeoverTheme = await run('document.documentElement.style.cssText');
    await run("Object.entries({'--bg-base':'#0a0a0a','--accent':'rgb(132,115,133)','--accent-soft':'rgba(132,115,133,.15)','--accent-glow':'rgba(132,115,133,.5)','--accent-grad':'linear-gradient(135deg, rgb(132,115,133), #000000)'}).forEach(([key, value]) => document.documentElement.style.setProperty(key, value))");
    await capture('device-takeover-adaptive');
    await run('document.documentElement.style.cssText = ' + JSON.stringify(savedTakeoverTheme));
    assert.equal(calls.filter(c => c.path.endsWith('/playbackResumed')).length, 0);
    await run("document.getElementById('stream-keep-listening').click()");
    await waitFor(() => run('AppState.playerState.streamBlocked && !AppState.isLoading'), 'declined takeover');
    assert.equal(await run('AppState.playerState.isPlaying'), false);

    await run('window.api.window.toggleMini()');
    assert.equal(win.getBounds().height, 80);
    // Use the actual Play button to verify a declined conflict can be revisited.
    await run("document.getElementById('play-pause-btn').click()");
    await waitFor(() => run("document.getElementById('stream-conflict-dialog').open"), 'mini player listening choice');
    win.setSize(480, 70);
    assert.equal(await run("document.getElementById('stream-take-over').getBoundingClientRect().bottom <= innerHeight && document.getElementById('stream-take-over').getBoundingClientRect().right <= innerWidth"), true, 'The takeover buttons fit the smallest mini player');
    assert.equal(await run("document.getElementById('stream-conflict-dialog').scrollHeight <= document.getElementById('stream-conflict-dialog').clientHeight"), true, 'Mini prompt must not need vertical scrolling');
    await capture('device-takeover-mini');
    await run("document.getElementById('stream-take-over').click()");
    await waitFor(() => run("AppState.playerState.trackToken === 'fixture-track-1' && !document.querySelector('audio')?.paused"), 'takeover audio');
    assert.equal(calls.filter(c => c.path.endsWith('/playbackResumed') && c.body.forceActive).length, 1);
    assert.equal(await run("document.getElementById('mini-thumb-up').classList.contains('liked')"), true);
    await capture('mini-saved-thumb');
    assert.equal(await run("getComputedStyle(document.getElementById('mini-thumb-up')).color"), 'rgb(29, 185, 84)');

    await run('window.api.window.toggleMini()');
    assert.equal(calls.some(c => c.path.includes('interactiveradio')), false, 'Modes load only in the expanded view');
    await run("document.getElementById('now-playing-art').click()");
    await waitFor(() => run("document.getElementById('np-mode-select')?.value === '0'"), 'mode list');
    const footerThumbsHidden = () => run("getComputedStyle(document.getElementById('mini-thumbs')).display === 'none'");
    assert.equal(await footerThumbsHidden(), true, 'Expanded player hides duplicate bottom-bar thumbs');
    await run('window.api.window.toggleMini()');
    await waitFor(async () => !await footerThumbsHidden(), 'mini player thumb controls');
    await run('window.api.window.toggleMini()');
    await waitFor(footerThumbsHidden, 'bottom-bar thumbs hidden after returning to expanded player');
    assert.equal(await run("document.getElementById('np-thumbup').classList.contains('liked')"), true);
    assert.equal(await run("document.getElementById('heart-btn').classList.contains('liked')"), true);
    await run("document.getElementById('np-thumbup').click()");
    await waitFor(() => run('!feedbackPending'), 'saved thumb interaction');
    assert.equal(calls.filter(c => c.path.endsWith('/addFeedback')).length, 0);
    assert.equal(await run('AppState.playerState.feedback'), 'thumbUp');
    await capture('normal-saved-thumb');
    assert.equal(await run("getComputedStyle(document.getElementById('np-thumbup')).color"), 'rgb(29, 185, 84)');

    const pauses = calls.filter(c => c.path.endsWith('/playbackPaused')).length;
    await run("document.querySelector('audio').pause()");
    await waitFor(() => calls.filter(c => c.path.endsWith('/playbackPaused')).length > pauses, 'normal pause notification');
    let approveResume;
    resumeGate = new Promise(resolve => { approveResume = resolve; });
    await run("document.getElementById('play-pause-btn').click()");
    await waitFor(() => calls.some(c => c.path.endsWith('/playbackResumed') && !c.body.forceActive), 'normal resume notification');
    assert.equal(await run("document.querySelector('audio').paused"), true, 'Buffered audio must wait for Pandora to approve resume');
    approveResume();
    resumeGate = null;
    await waitFor(() => run("!document.querySelector('audio').paused"), 'approved resume audio');
    assert.equal(await run('AppState.playerState.feedback'), 'thumbUp');
    await run('window.api.player.next()');
    await waitFor(() => run("AppState.playerState.trackToken === 'fixture-track-2' && !document.querySelector('audio').paused"), 'next saved thumb');
    assert.equal(await run("document.getElementById('np-thumbup').classList.contains('liked')"), true);
    assert.equal(await run("AppState.playerState.history[0].feedback"), 'liked');

    // Keep the current audio while pending, then switch immediately to the new mix.
    assert.equal(await run("document.querySelector('#np-mode-option-5') === null"), true);
    assert.equal(await run("document.querySelector('#np-mode-option-987654').textContent.includes('Curated <Mix>')"), true);
    assert.equal(await run("document.querySelectorAll('#np-station-tuning mix').length"), 0);
    const audioBefore = await run("document.querySelector('audio').src");
    let finishMode;
    modeGate = new Promise(resolve => { finishMode = resolve; });
    loseModeResponse = true;
    await run("document.querySelector('audio').currentTime = 12; document.getElementById('np-mode-select').click(); document.getElementById('np-mode-option-1091989').click()");
    await waitFor(() => run("AppState.playerState.stationModes.changing"), 'pending tuning');
    assert.equal(await run("document.getElementById('np-mode-select').value"), '0');
    assert.equal(await run("document.getElementById('np-mode-select').disabled"), true);
    assert.equal(await run("document.querySelector('audio').src"), audioBefore);
    assert.equal(await run("document.querySelector('audio').currentTime >= 12"), true);
    finishMode();
    modeGate = null;
    await waitFor(() => run("!AppState.playerState.stationModes.changing && document.getElementById('np-mode-select').value === '1091989'"), 'verified tuning');
    await waitFor(() => run("AppState.playerState.trackToken === 'tuned-1091989-fixture-track-1' && !document.querySelector('audio').paused"), 'immediate tuned playback');
    loseModeResponse = false;
    assert.equal(await run('AppState.playerState.stationModes.error'), null, 'Confirmed read-back must recover a lost setter response');
    assert.notEqual(await run("document.querySelector('audio').src"), audioBefore);
    assert.equal(await run("document.querySelector('audio').currentTime < 10"), true);
    assert.equal(await run("document.getElementById('np-thumbup').classList.contains('liked')"), true);
    assert.equal(await run("document.querySelector('.history-title').textContent"), 'Fixture Song 2');
    assert.equal(await run("document.getElementById('np-large-title').textContent"), 'Tuned Fixture Song 1');
    const fragments = calls.filter(c => c.path.endsWith('/getFragment'));
    assert.equal(fragments[fragments.length - 1].body.isStationStart, false);
    assert.deepEqual(calls.find(c => c.path.endsWith('/setAndGetAvailableModes')).body, { stationId: 'fixture-station', modeId: 1091989 });
    await run("document.querySelectorAll('.error-toast').forEach(toast => toast.remove())");
    await capture('station-tuning');
    const tuningLayout = () => run(`({
        panelHeight: document.getElementById('np-station-tuning').getBoundingClientRect().height,
        historyTop: document.querySelector('.np-history').getBoundingClientRect().top,
        scrollTop: document.getElementById('main-scroll').scrollTop
    })`);
    const menuFits = () => run(`(() => {
        const menu = document.getElementById('np-mode-menu');
        const bounds = menu.getBoundingClientRect();
        const viewport = document.getElementById('main-scroll').getBoundingClientRect();
        return !menu.hidden && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom &&
            bounds.left >= viewport.left && bounds.right <= viewport.right;
    })()`);
    const closedLayout = await tuningLayout();
    await run("document.getElementById('np-mode-select').click()");
    assert.equal(await run("document.getElementById('np-mode-menu').hidden"), false);
    assert.deepEqual(await tuningLayout(), closedLayout, 'Opening the menu must not grow the panel, move history or scroll the page');
    assert.equal(await menuFits(), true, 'All dropdown controls fit the content viewport');
    assert.equal(await run(`(() => {
        const menu = document.getElementById('np-mode-menu');
        const bounds = menu.getBoundingClientRect();
        const history = document.querySelector('.np-history').getBoundingClientRect();
        return menu.contains(document.elementFromPoint(bounds.left + bounds.width / 2, Math.max(bounds.top, history.top) + 8));
    })()`), true, 'The dropdown draws above history instead of behind it');
    await capture('station-mode-menu');
    win.setSize(900, 600);
    await waitFor(() => run('innerWidth === 900 && innerHeight === 600'), 'small player dimensions');
    await waitFor(menuFits, 'floating menu repositioned after resize');
    await run("closeStationModeMenu(); document.getElementById('np-mode-select').scrollIntoView({block:'center'})");
    const smallClosedLayout = await tuningLayout();
    await run("document.getElementById('np-mode-select').click()");
    assert.deepEqual(await tuningLayout(), smallClosedLayout, 'The small window also keeps the panel and history still');
    assert.equal(await menuFits(), true);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
    await waitFor(() => run("document.activeElement.id === 'np-mode-option-987654'"), 'last dropdown option');
    assert.deepEqual(await tuningLayout(), smallClosedLayout, 'Keyboard navigation scrolls only the menu');
    assert.equal(await run(`(() => {
        const option = document.activeElement.getBoundingClientRect();
        const menu = document.getElementById('np-mode-menu').getBoundingClientRect();
        return option.top >= menu.top && option.bottom <= menu.bottom;
    })()`), true, 'The last option remains visible in the constrained menu');
    await capture('station-tuning-small');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(() => run("document.getElementById('np-mode-menu').hidden"), 'keyboard menu dismissal');
    assert.equal(await run("document.querySelector('.np-right').getBoundingClientRect().right <= innerWidth"), true);
    win.setSize(1200, 800);

    await run("document.querySelector('audio').pause()");
    await waitFor(() => run('!AppState.playerState.isPlaying'), 'paused before changing modes');
    rejectMode = true;
    await run("document.getElementById('np-mode-select').click(); document.getElementById('np-mode-option-0').click()");
    await waitFor(() => run("!AppState.playerState.stationModes.changing && !!AppState.playerState.stationModes.error"), 'rejected mode');
    assert.equal(await run("document.getElementById('np-mode-select').value"), '1091989');
    assert.match(await run("document.getElementById('np-mode-status').textContent"), /did not enable/);
    assert.equal(await run('AppState.playerState.trackToken'), 'tuned-1091989-fixture-track-1', 'A rejection must not interrupt the song');
    assert.equal(await run("document.querySelector('audio').paused"), true, 'A rejected mode must not resume playback');

    modesFailed = true;
    await run("document.getElementById('np-mode-retry').click()");
    await waitFor(() => run("AppState.playerState.stationModes.status === 'error'"), 'mode load failure');
    modesFailed = false;
    await run("document.getElementById('np-mode-retry').click()");
    await waitFor(() => run("!document.getElementById('np-mode-select').disabled"), 'mode retry');

    artistOnlyAvailable = true;
    rejectMode = false;
    await run("document.getElementById('np-back-btn').click(); document.getElementById('now-playing-art').click()");
    await waitFor(() => run("AppState.playerState.stationModes.status === 'ready'"), 'Plus station modes');
    assert.equal(await run("!!document.querySelector('#np-mode-option-5')"), false, 'Plus must not display Artist Only even on an eligible station');
    const changesBeforeBlockedMode = calls.filter(c => c.path.endsWith('/setAndGetAvailableModes')).length;
    assert.equal((await run("window.api.player.setStationMode('fixture-station', 5)")).success, false);
    assert.equal(calls.filter(c => c.path.endsWith('/setAndGetAvailableModes')).length, changesBeforeBlockedMode);
    // Upgrade the same fixture account, then reload the modes through real IPC.
    premiumAccount = true;
    assert.equal((await run("window.api.auth.login('fixture@example.invalid', 'fixture-password')")).success, true);
    await run("document.getElementById('np-back-btn').click(); document.getElementById('now-playing-art').click()");
    await waitFor(() => run("!!document.querySelector('#np-mode-option-5')"), 'eligible Artist Only');
    const reusedAudioURL = await run("document.querySelector('audio').src");
    const resumesBeforeMode = calls.filter(c => c.path.endsWith('/playbackResumed')).length;
    let approveModeResume;
    resumeGate = new Promise(resolve => { approveModeResume = resolve; });
    await run("document.querySelector('audio').currentTime = 12; document.getElementById('np-mode-select').click(); document.getElementById('np-mode-option-5').click()");
    await waitFor(() => calls.filter(c => c.path.endsWith('/playbackResumed')).length > resumesBeforeMode, 'mode resume approval');
    assert.equal(calls.filter(c => c.path.endsWith('/playbackResumed')).at(-1).body.forceActive, false);
    assert.equal(await run("document.querySelector('audio').paused"), true);
    assert.equal(await run('AppState.playerState.trackToken'), 'tuned-1091989-fixture-track-1');
    // Pausing the old song while the mode is still changing must not cancel
    // playback of the new mode's first song once approval arrives.
    await run('void window.api.player.play()');
    await run('window.api.player.pause()');
    assert.equal(calls.filter(c => c.path.endsWith('/playbackResumed')).length, resumesBeforeMode + 1,
        'Play during a mode change must not send a duplicate resume request');
    approveModeResume();
    resumeGate = null;
    await waitFor(() => run("AppState.playerState.trackToken === 'tuned-5-fixture-track-1' && !document.querySelector('audio').paused"), 'Artist Only playback');
    assert.equal(await run("document.querySelector('audio').src"), reusedAudioURL);
    assert.equal(await run("document.querySelector('audio').currentTime < 10"), true, 'A fresh track token restarts even a reused audio URL');

    await run("document.querySelector('audio').pause()");
    await waitFor(() => run('!AppState.playerState.isPlaying'), 'normal pause of the new song');

    modesUnavailable = true;
    await run("document.getElementById('np-back-btn').click(); document.getElementById('now-playing-art').click()");
    await waitFor(() => run("AppState.playerState.stationModes.status === 'ready' && !AppState.playerState.stationModes.available"), 'station without modes');
    assert.equal(await run("document.getElementById('np-station-tuning').hidden && !document.getElementById('np-mode-select')"), true);
    assert.equal(await run("document.querySelector('audio').paused"), true, 'The new song stays paused through subsequent state updates');

    modesUnavailable = false;
    const modeRequestsBeforeShuffle = calls.filter(c => c.path.includes('interactiveradio')).length;
    await run("document.getElementById('shuffle-stations-btn').click()");
    await waitFor(() => run('AppState.playerState.isShuffle'), 'sidebar Shuffle');
    assert.equal(await run("document.querySelectorAll('#stations-list .active').length"), 1);
    assert.equal(await run("document.querySelector('#stations-list .active').id"), 'shuffle-stations-btn');
    await run('renderStationsList()');
    assert.equal(await run("document.querySelector('#stations-list .active').id"), 'shuffle-stations-btn');
    await run("document.getElementById('now-playing-art').click()");
    assert.equal(await run('AppState.playerState.isShuffle'), true);
    assert.equal(await run("getComputedStyle(document.getElementById('np-station-tuning')).display"), 'none');
    assert.equal(await run("document.getElementById('np-mode-select') === null"), true);
    assert.equal(calls.filter(c => c.path.includes('interactiveradio')).length, modeRequestsBeforeShuffle);
    await waitFor(() => run("!document.querySelector('audio').paused"), 'Shuffle audio');
    await capture('shuffle-without-tuning');

    await run("window.api.content.playItem({type:'station', id:'fixture-station'})");
    assert.equal(await run("document.querySelector('#stations-list .active')?.dataset.id"), 'fixture-station');
    assert.equal(await run("document.getElementById('shuffle-stations-btn').classList.contains('active')"), false);

    // A later conflict must stop already buffered audio before asking again.
    canStream = false;
    await run('void window.api.player.getMoreTracks()');
    await waitFor(() => run("document.getElementById('stream-conflict-dialog').open"), 'background stream conflict');
    await waitFor(() => run("document.querySelector('audio').paused"), 'buffered audio stopped');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(() => run("!document.getElementById('stream-conflict-dialog').open"), 'Escape keeps this player paused');
    assert.equal(calls.filter(c => c.path.endsWith('/playbackResumed') && c.body.forceActive).length, 1);

    canStream = true;
    await run("renderPage('home'); document.querySelector('#home-recent [data-id=\"removable-station\"]').click()");
    await waitFor(() => run("AppState.playerState.stationId === 'removable-station' && !AppState.playerState.stationLoading"), 'Home station playback');
    assert.equal(await run("document.querySelector('#home-recent .card').dataset.id"), 'removable-station');
    await run("document.querySelector('#home-recent [data-id=\"fixture-station\"]').click()");
    await waitFor(() => run("AppState.playerState.stationId === 'fixture-station' && !AppState.playerState.stationLoading"), 'Home station switch');
    assert.equal(await run("document.querySelector('#home-recent .card').dataset.id"), 'fixture-station');
    await run("document.querySelector('#stations-list [data-id=\"removable-station\"] .delete-btn').click()");
    await waitFor(() => run("document.getElementById('station-remove-dialog').open"), 'themed station removal');
    assert.equal(await run('document.activeElement.id'), 'station-remove-cancel');
    assert.equal(await run("document.getElementById('station-remove-name').textContent"), 'Thunder (Live/Acoustic) Radio');
    await capture('station-removal');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(() => run("!document.getElementById('station-remove-dialog').open"), 'Escape cancels removal');
    assert.equal(calls.filter(c => c.path.endsWith('/removeStation')).length, 0);
    removalFailed = true;
    await run("document.querySelector('[data-id=\"removable-station\"] .delete-btn').click(); document.getElementById('station-remove-confirm').click()");
    await waitFor(() => run("!document.getElementById('station-remove-error').hidden"), 'inline removal error');
    assert.equal(await run("document.getElementById('station-remove-dialog').open && !document.getElementById('station-remove-confirm').disabled"), true);
    assert.equal(await run("!!document.querySelector('#home-recent [data-id=\"removable-station\"]')"), true, 'Failed removal keeps the Home card');
    removalFailed = false;
    await run("document.getElementById('station-remove-confirm').click()");
    await waitFor(() => run("!document.getElementById('station-remove-dialog').open && !AppState.stations.some(station => station.id === 'removable-station')"), 'confirmed removal');
    assert.equal(await run("document.querySelector('#home-recent [data-id=\"removable-station\"]') === null"), true, 'Sidebar removal updates Home without navigation');
    assert.equal(await run("document.querySelector('#home-recent .card').dataset.id"), 'fixture-station');
    assert.equal(await run("!!document.querySelector('[data-id=\"fixture-station\"]')"), true);
    assert.equal(calls.filter(c => c.path.endsWith('/removeStation')).length, 2);
    assert.equal(calls.filter(c => c.path.endsWith('/removeStation')).every(c => c.body.stationId === 'removable-station'), true);
    assert.equal(await run("!!document.querySelector('#home-recent [data-id=\"fixture-shuffle\"]')"), true, 'Collection refresh after removal preserves Shuffle');
    const shuffleRequests = calls.filter(c => c.path.endsWith('/station/shuffle')).length;
    await new Promise(resolve => {
        win.webContents.once('did-finish-load', resolve);
        win.webContents.reload();
    });
    await waitFor(() => run("AppState.isLoggedIn && !!document.querySelector('#home-recent [data-id=\"fixture-shuffle\"]')"), 'Shuffle restored in Home at initialization');
    assert.equal(calls.filter(c => c.path.endsWith('/station/shuffle')).length, shuffleRequests, 'Restore the card without requesting Shuffle playback');
    await run("document.querySelector('#home-recent [data-id=\"fixture-shuffle\"]').click()");
    await waitFor(() => run("AppState.playerState.isShuffle && !AppState.playerState.stationLoading"), 'restored Home Shuffle card plays');
    assert.equal(calls.filter(c => c.path.endsWith('/station/shuffle')).length, shuffleRequests + 1);
    assert.equal(await run("document.querySelectorAll('#home-recent [data-id=\"fixture-shuffle\"]').length"), 1);
    console.log('Native player smoke test passed: device takeover, saved thumbs, immediate mode changes and approved auto-resume, Artist Only eligibility, Shuffle exclusion, mode failures and retry.');
    console.log('Screenshots: ' + testData);
    clearTimeout(deadline);
    app.quit();
}).catch(error => {
    clearTimeout(deadline);
    console.error(error);
    app.exit(1);
});
