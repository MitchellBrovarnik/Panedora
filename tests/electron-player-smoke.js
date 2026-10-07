/**
 * Exercise the real renderer, preload and IPC against local HTTPS fixtures.
 * Dialog choices are controlled by this test; no real account is contacted.
 * Run with: electron tests/electron-player-smoke.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session, powerMonitor } = require('electron');

const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'panedora-player-test-'));
app.setPath('userData', testData);
app.disableHardwareAcceleration();
// Exercise the release-only update checker with intercepted network fixtures.
Object.defineProperty(app, 'isPackaged', { value: true });
const deadline = setTimeout(() => { console.error('Native player test timed out'); app.exit(1); }, 90000);
let discordServer;

async function waitFor(check, description, timeout = 6000) {
    const end = Date.now() + timeout;
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
    let updateClock = Date.now();
    let releaseTag = 'v99.0.0';
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
    let stressTracks = null;
    let recoveryFragments = null;
    let freshTracks = null;
    let refillGate = null;
    let slowAudioGate = null;
    let coverGate = null;
    let heldCoverRequests = 0;
    const audioRequests = [];
    const audio = silentWav();
    const tracks = [1, 2, 3, 4].map(n => ({
        trackToken: 'fixture-track-' + n, songTitle: 'Fixture Song ' + n,
        artistName: 'Fixture Artist', albumTitle: 'Fixture Album', albumArt: art,
        audioURL: 'https://fixture.invalid/audio-' + n + '.wav', trackLength: 60,
        rating: n === 1 ? 1 : n === 2 ? '1' : 0
    }));
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
        status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
    // Intercept every HTTPS request, including images and the audio fixture.
    session.defaultSession.protocol.handle('https', async request => {
        const url = new URL(request.url);
        if (url.pathname === '/missing-large.svg' || url.pathname === '/audio-error.wav') {
            return new Response('Unavailable fixture', { status: 503 });
        }
        if (url.pathname === '/held-cover.svg') {
            heldCoverRequests++;
            if (coverGate) await coverGate;
        }
        if (url.pathname.endsWith('.svg')) return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="#487ad9"/><circle cx="250" cy="250" r="135" fill="#202947"/><circle cx="250" cy="250" r="26" fill="#a5b9f0"/></svg>',
            { headers: { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*',
                ...(url.pathname === '/held-cover.svg' ? { 'Cache-Control': 'no-store' } : {}) } });
        if (url.pathname.endsWith('.wav')) {
            audioRequests.push(url.pathname);
            if (url.pathname === '/slow-audio.wav' && slowAudioGate) await slowAudioGate;
            // Seekable responses let the real media element reach its natural end.
            const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') || '');
            const start = range ? Number(range[1]) : 0;
            const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
            return new Response(audio.subarray(start, end + 1), {
                status: range ? 206 : 200,
                headers: { 'Content-Type': 'audio/wav', 'Access-Control-Allow-Origin': '*',
                    'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
                    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${audio.length}` } : {}) }
            });
        }
        const body = request.method === 'POST' ? JSON.parse(await request.text()) : {};
        calls.push({ path: url.pathname, host: url.hostname, body });
        switch (url.pathname) {
            case '/repos/MitchellBrovarnik/Panedora/releases/latest':
                return json({ tag_name: releaseTag, draft: false, prerelease: false,
                    assets: ['Panedora.exe', 'Panedora-arm64.dmg', 'Panedora.AppImage'].map(name => ({
                        name, browser_download_url: 'https://github.com/MitchellBrovarnik/Panedora/releases/download/' + releaseTag + '/' + name
                    })) });
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
                if (recoveryFragments) {
                    const fragment = recoveryFragments.shift();
                    assert.ok(fragment, 'Unexpected recovery playlist request');
                    if (fragment.wait) await fragment.wait;
                    return json({ tracks: fragment.tracks });
                }
                if (stressTracks) {
                    if (!body.isStationStart && refillGate) await refillGate;
                    return json({ tracks: body.isStationStart ? stressTracks : freshTracks });
                }
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

    // Advance only the checker clock; other authentication/playback clocks remain real.
    const updates = require('../update-checker');
    const RealUpdateChecker = updates.UpdateChecker;
    updates.UpdateChecker = class extends RealUpdateChecker {
        constructor(options) { super({ ...options, now: () => updateClock }); }
    };
    const { createDiscordFixture } = require('./discord-fixture');
    const { DiscordRpc } = require('../discord-rpc');
    const discord = require('../discord-presence');
    const RealPresence = discord.DiscordPresence;
    discordServer = await createDiscordFixture();
    discord.DiscordPresence = class extends RealPresence {
        constructor(options) {
            const clientId = '123456789012345678';
            super({ ...options, clientId, rpc: new DiscordRpc({ clientId, paths: [discordServer.socketPath] }) });
        }
    };
    require('../main');
    updates.UpdateChecker = RealUpdateChecker;
    discord.DiscordPresence = RealPresence;
    await waitFor(() => BrowserWindow.getAllWindows().length, 'main window');
    const win = BrowserWindow.getAllWindows()[0];
    const run = async script => {
        try { return await win.webContents.executeJavaScript(script, true); }
        catch (error) { throw new Error('Renderer script failed: ' + script, { cause: error }); }
    };
    const capture = async name => {
        // Wait for entry animations and a compositor frame, not just DOM changes.
        await run('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 500))');
        fs.writeFileSync(path.join(testData, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    async function exerciseQueuedPlayback() {
        // The cover must load directly in the visible player, without waiting
        // for a hidden probe and then starting a second image load.
        await run("renderPage('home')");
        let finishCover;
        coverGate = new Promise(resolve => { finishCover = resolve; });
        assert.equal(await run(`
            updatePlayerUI({ coverArt: 'https://fixture.invalid/held-cover.svg', coverArtSources: [] });
            document.getElementById('now-playing-art').getAttribute('src');
        `), 'https://fixture.invalid/held-cover.svg', 'A valid cover URL reaches the visible image immediately');
        await waitFor(() => heldCoverRequests > 0, 'direct cover request');
        assert.equal(heldCoverRequests, 1);
        finishCover();
        await waitFor(() => run("document.getElementById('now-playing-art').naturalWidth > 0 && document.getElementById('now-playing-art').complete"), 'direct cover displays');
        assert.equal(heldCoverRequests, 1, 'Displaying a non-cacheable cover must not request it again after a probe');
        coverGate = null;

        activeMode = 0;
        stressTracks = tracks.map((track, index) => ({ ...track, trackToken: 'stress-' + (index + 1),
            audioURL: index === 1 ? 'https://fixture.invalid/slow-audio.wav' : track.audioURL,
            albumArt: index === 0 ? [{ size: 1080, url: 'https://fixture.invalid/missing-large.svg' }, ...art]
                : index === 2 ? [] : [{ size: 500, url: 'https://fixture.invalid/next-art.svg' }] }));
        freshTracks = tracks.slice(0, 3).map((track, index) => ({ ...track, trackToken: 'fresh-' + (index + 1),
            audioURL: index === 1 ? 'https://fixture.invalid/audio-error.wav' : track.audioURL }));
        await run("window.api.content.playItem({type:'station', id:'fixture-station'})");
        await waitFor(() => run("AppState.playerState.trackToken === 'stress-1' && !document.querySelector('audio').paused && document.getElementById('now-playing-art').src === 'https://fixture.invalid/art.svg'"), 'first song plays with fallback artwork');
        await run("document.getElementById('now-playing-art').click()");
        await waitFor(() => run("document.getElementById('np-large-art').naturalWidth > 0 && document.getElementById('np-large-art').src === 'https://fixture.invalid/art.svg'"), 'expanded player uses the working supplied image size');
        let finishAudio;
        let finishRefill;
        slowAudioGate = new Promise(resolve => { finishAudio = resolve; });
        refillGate = new Promise(resolve => { finishRefill = resolve; });
        const fragmentsBefore = calls.filter(c => c.path.endsWith('/getFragment')).length;
        await run('nextPlayerTrack()');
        await waitFor(() => audioRequests.includes('/slow-audio.wav'), 'second song starts loading');
        await run('Promise.all([nextPlayerTrack(), nextPlayerTrack(), nextPlayerTrack()])');
        await waitFor(() => run("AppState.playerState.trackToken === 'stress-3' && !document.querySelector('audio').paused"), 'rapid skips reach the ready queued song without waiting for the refill');
        assert.equal(calls.filter(c => c.path.endsWith('/getFragment')).length, fragmentsBefore + 1);
        assert.equal(await run("document.getElementById('now-playing-art').src.startsWith('data:image/svg') && document.getElementById('np-large-art').src.startsWith('data:image/svg')"), true, 'A song without artwork clears the previous cover in both players');
        finishAudio();
        await waitFor(() => run("Number.isFinite(document.querySelector('audio').duration) && document.querySelector('audio').duration > 0"), 'seekable song duration');
        await run("document.querySelector('audio').currentTime = document.querySelector('audio').duration - 0.08");
        await waitFor(() => run("AppState.playerState.trackToken === 'stress-4' && !document.querySelector('audio').paused"), 'natural ending plays the queued song while refill is still delayed');
        await waitFor(() => run("document.getElementById('np-large-art').src === 'https://fixture.invalid/next-art.svg' && document.getElementById('np-large-art').naturalWidth > 0"), 'the next cover recovers after a missing image');
        await waitFor(() => run("Number.isFinite(document.querySelector('audio').duration) && document.querySelector('audio').duration > 0"), 'last queued song duration');
        await run("document.querySelector('audio').currentTime = document.querySelector('audio').duration - 0.08");
        await waitFor(() => run("document.querySelector('audio').ended"), 'last queued song finishes');
        await run("document.querySelector('audio').dispatchEvent(new Event('ended')); document.querySelector('audio').dispatchEvent(new Event('ended'))");
        assert.equal(calls.filter(c => c.path.endsWith('/getFragment')).length, fragmentsBefore + 1, 'Natural endings share the existing refill');
        finishRefill();
        await waitFor(() => run("AppState.playerState.trackToken === 'fresh-1' && !document.querySelector('audio').paused"), 'empty queue resumes automatically when the refill arrives');
        await run('nextPlayerTrack()');
        await waitFor(() => run("AppState.playerState.trackToken === 'fresh-2' && !!document.querySelector('audio').error"), 'failed audio source');
        await run('nextPlayerTrack()');
        await waitFor(() => run("AppState.playerState.trackToken === 'fresh-3' && !document.querySelector('audio').paused"), 'manual skip recovers from failed audio');
        await new Promise(resolve => setTimeout(resolve, 2200));
        assert.equal(await run('AppState.playerState.trackToken'), 'fresh-3', 'The old audio error cannot skip the recovered song later');
        assert.equal(await run("document.querySelectorAll('audio').length"), 1);
        await capture('rapid-skip-recovered');
        console.log('Direct artwork loading, rapid skips, slow audio and playlist responses, real natural song endings, stale error recovery, first-song artwork recovery and clearing missing covers passed.');
    }

    async function exerciseAudioRecovery() {
        stressTracks = null;
        activeMode = 2;
        await run("document.querySelectorAll('.error-toast').forEach(toast => toast.remove())");
        const expired = tracks.slice(0, 3).map((track, index) => ({ ...track,
            trackToken: 'expired-' + index, audioURL: 'https://fixture.invalid/audio-error.wav?expired=' + index }));
        const recovered = tracks.map((track, index) => ({ ...track,
            trackToken: 'recovered-' + index, audioURL: 'https://fixture.invalid/recovered-' + index + '.wav' }));
        let finishOldRefill;
        recoveryFragments = [
            { tracks: expired },
            { tracks: expired, wait: new Promise(resolve => { finishOldRefill = resolve; }) },
            { tracks: recovered }
        ];
        const before = calls.filter(c => c.path.endsWith('/getFragment')).length;
        await run("window.api.content.playItem({type:'station', id:'fixture-station'})");
        await run("window.api.player.getStationModes('fixture-station')");
        await waitFor(() => run("AppState.playerState.trackToken === 'recovered-0' && document.querySelector('audio').currentTime > 0"), 'failed cached songs automatically request and play fresh audio', 10000);
        assert.equal(await run('AppState.playerState.stationModes.currentModeId'), 2);
        assert.equal(await run("document.querySelectorAll('.error-toast').length"), 0, 'No final error while fresh audio can recover');
        const fragments = calls.filter(c => c.path.endsWith('/getFragment')).slice(before);
        assert.deepEqual(fragments.map(c => c.body.isStationStart), [true, false, false], 'Recovery continues the selected mode');
        finishOldRefill();
        await run('nextPlayerTrack()');
        await waitFor(() => run("AppState.playerState.trackToken === 'recovered-1' && document.querySelector('audio').currentTime > 0"), 'old delayed refill cannot reintroduce expired audio');

        recoveryFragments = [{ tracks: expired }, { tracks: recovered }];
        await run("window.api.content.playItem({type:'station', id:'fixture-station'})");
        await waitFor(() => run("!!document.querySelector('audio').error"), 'terminal media error before pausing');
        await run('pausePlayerPlayback(); window.api.player.pause()');
        assert.equal(await run('AppState.playerState.isPlaying'), false);
        const resumesBefore = calls.filter(c => c.path.endsWith('/playbackResumed')).length;
        await run("document.getElementById('play-pause-btn').click()");
        await waitFor(() => run("AppState.playerState.trackToken === 'recovered-0' && document.querySelector('audio').currentTime > 0"), 'approved Play recovers a terminal source without a second media error');
        assert.equal(calls.filter(c => c.path.endsWith('/playbackResumed')).length, resumesBefore + 1);
        assert.equal(calls.filter(c => c.path.endsWith('/playbackResumed')).at(-1).body.forceActive, false);
        recoveryFragments = null;
        console.log('Native audio recovery passed: real failed URLs, automatic skips, fresh playlist, selected mode, delayed old refill and approved retry of terminal media errors.');
    }

    await waitFor(() => run("!!document.getElementById('login-form')"), 'login UI');
    await waitFor(() => run("!document.getElementById('update-banner').hidden"), 'new release banner');
    await run('document.fonts.ready');
    assert.equal(await run("document.fonts.check('16px Inter')"), true, 'App uses the bundled font');
    assert.equal(await run("document.querySelector('dialog[open]') === null && !document.getElementById('update-banner').contains(document.activeElement)"), true, 'Update banner does not open a modal or take focus');
    assert.equal(await run("document.getElementById('update-available-version').textContent"), '99.0.0');
    assert.equal(await run("document.getElementById('update-banner').getBoundingClientRect().width <= 390 && document.getElementById('update-banner').getBoundingClientRect().height < 50"), true, 'Update pill remains compact');
    assert.equal(await run("document.getElementById('update-banner').scrollHeight <= document.getElementById('update-banner').clientHeight"), true, 'Update banner has no clipping or scrolling');
    assert.equal(await run("(() => { const pill = document.getElementById('update-banner').getBoundingClientRect(); const main = document.querySelector('.main-content').getBoundingClientRect(); const header = getComputedStyle(document.getElementById('main-header')); return Math.abs((pill.left + pill.right - main.left - main.right) / 2) < 1 && header.backgroundColor === 'rgba(0, 0, 0, 0)' && header.borderBottomWidth === '0px'; })()"), true, 'Update pill is centered without a full-width background or divider');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    assert.equal(await run("document.getElementById('update-banner').hidden"), false, 'Escape does not trigger an update choice');
    await run('window.api.window.toggleMini()');
    await waitFor(() => run("document.body.classList.contains('mini-mode') && document.getElementById('update-banner').hidden"), 'mini mode hides update banner');
    assert.equal(await run("getComputedStyle(document.getElementById('update-banner')).display"), 'none');
    assert.equal(await run("document.querySelector('dialog[open]')"), null);
    await capture('update-banner-mini-hidden');
    await run('window.api.window.toggleMini()');
    await waitFor(() => run("!document.body.classList.contains('mini-mode') && !document.getElementById('update-banner').hidden"), 'full app restores update banner');
    assert.equal((await run("window.api.auth.login('fixture@example.invalid', 'fixture-password')")).success, true);
    await waitFor(() => run('AppState.stations.length === 2'), 'station collection');
    // The empty test profile emits a startup sign-in toast before fixture login.
    await run("document.querySelectorAll('.error-toast').forEach(toast => toast.remove())");
    await capture('update-banner');
    await run("renderPage('search'); document.getElementById('search-input').focus()");
    win.setSize(900, 600);
    await waitFor(() => run('innerWidth === 900'), 'minimum app window');
    assert.equal(await run("(() => { const pill = document.getElementById('update-banner').getBoundingClientRect(); const search = document.getElementById('search-container').getBoundingClientRect(); const header = document.getElementById('main-header').getBoundingClientRect(); return Math.abs((pill.left + pill.right - header.left - header.right) / 2) < 1 && pill.left >= search.right && search.width > 150 && pill.right <= header.right && pill.top >= header.top && pill.bottom <= header.bottom && document.documentElement.scrollWidth <= innerWidth; })()"), true, 'Pill stays centered and search fits the minimum window without overlap or horizontal scrolling');
    assert.equal(await run('document.activeElement.id'), 'search-input', 'Search remains focused with the banner visible');
    await capture('update-banner-search-small');
    win.setSize(1200, 800);
    await run("renderPage('home'); document.getElementById('update-later').click()");
    await waitFor(() => run("document.getElementById('update-banner').hidden"), 'Later postpones update');
    assert.equal(await run("document.getElementById('main-header').hidden"), true, 'Home keeps no empty update row after dismissal');
    const snooze = require('../config').getUpdateSnooze();
    assert.equal(snooze.version, '99.0.0');
    assert.ok(snooze.until > Date.now() + 23 * 60 * 60 * 1000);
    assert.equal(calls.filter(c => c.host === 'api.github.com').length, 1);

    await run("AppState.searchQuery = 'fixture'; renderPage('search'); window.api.content.search('fixture')");
    assert.equal(await run("document.getElementById('main-header').hidden"), false, 'Search input stays available after update dismissal');
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

    updateClock += 2 * 60 * 60 * 1000;
    win.emit('focus');
    updateClock += 4 * 60 * 60 * 1000;
    powerMonitor.emit('resume');
    await run('window.api.updates.check()');
    assert.equal(calls.filter(c => c.host === 'api.github.com').length, 1, 'Two hours open plus four asleep does not bypass the daily deadline');
    await run('window.api.window.toggleMini()');
    await waitFor(() => run("document.body.classList.contains('mini-mode')"), 'mini mode before scheduled notice');
    releaseTag = 'v99.1.0';
    updateClock += 18 * 60 * 60 * 1000;
    powerMonitor.emit('resume');
    win.emit('focus');
    await waitFor(() => run("updateNotice?.version === '99.1.0'"), 'new release pushed on wake after 24 elapsed hours');
    assert.equal(calls.filter(c => c.host === 'api.github.com').length, 2, 'Wake and focus share one due request');
    assert.equal(await run("document.getElementById('update-banner').hidden && document.querySelector('dialog[open]') === null"), true, 'Scheduled notices never open over the mini player');
    assert.equal(await run('AppState.playerState.isPlaying'), false, 'Paused playback does not prevent a scheduled check');
    assert.equal(await run("document.querySelector('audio').paused"), true, 'The update check leaves the song paused');
    await run('window.api.window.toggleMini()');
    await waitFor(() => run("!document.getElementById('update-banner').hidden && document.getElementById('update-available-version').textContent === '99.1.0'"), 'new notice appears after returning to full app');
    assert.equal(await run("document.getElementById('update-banner').contains(document.activeElement)"), false, 'New notices leave keyboard focus alone');
    await capture('scheduled-update-notice');
    await run("document.getElementById('update-later').click()");
    await waitFor(() => run("document.getElementById('update-banner').hidden"), 'Later postpones scheduled notice');

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
    // Sign-in returns the renderer to Home, so its expanded-player Back button is gone.
    await run("document.getElementById('now-playing-art').click()");
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
    assert.equal(await run("document.querySelector('#stations-list .station-item[data-id]').dataset.id"), 'removable-station');
    const rememberedPlay = require('../config').getStationRecency()['removable-station'];
    assert.ok(rememberedPlay, 'Recent station is saved outside the renderer');
    for (let i = 0; i < 2; i++) {
        const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        win.reload(); await loaded;
        await waitFor(() => run("AppState.isLoggedIn && document.querySelector('#home-recent .card')?.dataset.id === 'removable-station'"), 'Ctrl+R preserves the recent Home station despite stale collection dates');
        assert.equal(await run("document.querySelector('#stations-list .station-item[data-id]').dataset.id"), 'removable-station');
        assert.equal(require('../config').getStationRecency()['removable-station'], rememberedPlay, 'Reloading does not promote a station again');
    }
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
    assert.equal(await run("document.querySelector('#home-recent [data-id=\"fixture-shuffle\"] .card-remove-button') === null"), true, 'Home Shuffle cannot be removed');
    await capture('home-station-removal');
    await run("document.querySelector('#home-recent [data-id=\"removable-station\"] .card-remove-button').click()");
    await waitFor(() => run("document.getElementById('station-remove-dialog').open"), 'Home card remove opens confirmation');
    assert.equal(await run("document.getElementById('station-remove-name').textContent"), 'Thunder (Live/Acoustic) Radio');
    await run("document.getElementById('station-remove-cancel').click()");
    await run("renderPage('library')");
    assert.equal(await run("document.querySelector('#library-shuffle-card .card-remove-button') === null"), true, 'Shuffle cannot be removed');
    await capture('library-station-removal');
    const fragmentsBeforeRemoval = calls.filter(c => c.path.endsWith('/getFragment')).length;
    await run("document.getElementById('library-filter').value = 'Thunder'; document.getElementById('library-filter').dispatchEvent(new Event('input', {bubbles:true}))");
    await waitFor(() => run("document.querySelectorAll('#library-cards .card').length === 1"), 'filtered Library station');
    win.focus();
    win.webContents.focus();
    await run("document.getElementById('library-filter').focus()");
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await waitFor(() => run("getComputedStyle(document.querySelector('#library-cards .card-remove-button')).opacity === '0'"), 'Unfocused station card hides the remove button');
    const cardHoverPoint = await run("(() => { const card = document.querySelector('#library-cards .card'); const r = card.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 12) }; })()");
    win.webContents.sendInputEvent({ type: 'mouseMove', ...cardHoverPoint });
    await waitFor(() => run("getComputedStyle(document.querySelector('#library-cards .card-remove-button')).opacity === '1'"), 'Hover reveals the remove button');
    assert.equal(await run("(() => { const button = document.querySelector('#library-cards .card-remove-button'); const card = button.closest('.card'); const b = button.getBoundingClientRect(); const c = card.getBoundingClientRect(); const art = card.querySelector('.card-image').getBoundingClientRect(); return getComputedStyle(button).width === '20px' && getComputedStyle(button).height === '20px' && b.top >= c.top && b.bottom <= art.top && b.right <= c.right && c.right - b.right <= 8; })()"), true, 'Smaller X sits inside the card top-right corner without covering the artwork');
    await capture('library-station-removal-hover');
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await waitFor(() => run("getComputedStyle(document.querySelector('#library-cards .card-remove-button')).opacity === '0'"), 'Leaving the card hides the remove button');
    await run("document.querySelector('#library-cards .card-remove-button').focus()");
    assert.equal(await run("document.activeElement.classList.contains('card-remove-button')"), true);
    await waitFor(() => run("getComputedStyle(document.querySelector('#library-cards .card-remove-button')).opacity === '1'"), 'Keyboard focus reveals the remove button');
    // sendInputEvent does not synthesize the character event from keyDown.
    // A real Enter press includes the carriage return that activates a button.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await waitFor(() => run("document.getElementById('station-remove-dialog').open"), 'keyboard activation of the Library remove button');
    await run("document.getElementById('station-remove-cancel').click()");
    assert.equal(calls.filter(c => c.path.endsWith('/removeStation')).length, 0);
    removalFailed = true;
    await run("document.querySelector('#library-cards [data-id=\"removable-station\"] .card-remove-button').click(); document.getElementById('station-remove-confirm').click()");
    await waitFor(() => run("!document.getElementById('station-remove-error').hidden"), 'inline removal error');
    assert.equal(await run("document.getElementById('station-remove-dialog').open && !document.getElementById('station-remove-confirm').disabled"), true);
    assert.equal(await run("!!document.querySelector('#library-cards [data-id=\"removable-station\"]')"), true, 'Failed removal keeps the Library card');
    removalFailed = false;
    await run("document.getElementById('station-remove-confirm').click()");
    await waitFor(() => run("!document.getElementById('station-remove-dialog').open && !AppState.stations.some(station => station.id === 'removable-station')"), 'confirmed removal');
    assert.equal(await run("document.querySelector('#library-cards [data-id=\"removable-station\"]') === null && document.querySelector('#stations-list [data-id=\"removable-station\"]') === null"), true, 'Library and sidebar update immediately');
    assert.equal(await run("document.getElementById('library-filter').value === 'Thunder' && document.activeElement.id === 'library-filter'"), true, 'Keep the filter and return focus to it after removal');
    assert.equal(calls.filter(c => c.path.endsWith('/getFragment')).length, fragmentsBeforeRemoval, 'Removing stations must not start playback');
    await run("renderPage('home')");
    assert.equal(await run("document.querySelector('#home-recent [data-id=\"removable-station\"]') === null"), true, 'The removed station stays out of Home');
    assert.equal(await run("document.querySelector('#home-recent .card').dataset.id"), 'fixture-station');
    assert.equal(await run("!!document.querySelector('[data-id=\"fixture-station\"]')"), true);
    assert.equal(calls.filter(c => c.path.endsWith('/removeStation')).length, 2);
    assert.equal(calls.filter(c => c.path.endsWith('/removeStation')).every(c => c.body.stationId === 'removable-station'), true);
    assert.equal(require('../config').getStationRecency()['removable-station'], undefined, 'Deleting a station also clears its saved recency');
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
    assert.equal(await run("document.getElementById('update-banner').hidden"), true, 'Renderer reload respects the update choice');
    assert.equal(calls.filter(c => c.host === 'api.github.com').length, 2, 'Reloads and station changes do not bypass the daily deadline');

    const site = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await site.loadFile(path.join(__dirname, '..', 'docs', 'index.html'));
    const siteRun = script => site.webContents.executeJavaScript(script);
    await waitFor(() => siteRun("document.getElementById('latest-release-label').textContent === 'Latest release: v99.1.0'"), 'website release links');
    await siteRun('document.fonts.ready');
    assert.equal(await siteRun("document.fonts.check('16px Inter') && document.fonts.check('16px boxicons')"), true, 'Website fonts and icons load locally');
    assert.match(await siteRun("document.getElementById('download-mac').textContent"), /Apple Silicon/);
    const captureSite = async name => {
        await siteRun("document.querySelectorAll('.reveal').forEach(el => el.classList.add('active')); new Promise(resolve => setTimeout(resolve, 900))");
        assert.equal(await siteRun('document.documentElement.scrollWidth <= innerWidth'), true, 'Website fits the viewport');
        fs.writeFileSync(path.join(testData, name + '.png'), (await site.webContents.capturePage()).toPNG());
    };
    await captureSite('website-desktop');
    await siteRun("document.getElementById('features').scrollIntoView()");
    await captureSite('website-features');
    site.setContentSize(430, 900);
    await siteRun('window.scrollTo(0, 0)');
    await captureSite('website-mobile');
    await siteRun("document.getElementById('download').scrollIntoView()");
    await captureSite('website-downloads-mobile');
    assert.equal(calls.some(c => ['fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com'].includes(c.host)), false, 'App and website make no external font or icon requests');
    site.close();
    await exerciseQueuedPlayback();
    await exerciseAudioRecovery();
    // Real audio -> renderer -> isolated preload -> main -> actual local IPC frames.
    assert.equal(discordServer.connections.length, 0, 'Discord is opt-in throughout normal playback');
    stressTracks = null; freshTracks = null; activeMode = 0; canStream = true;
    await run("window.api.content.playItem({type:'station', id:'fixture-station'})");
    await waitFor(() => run("document.querySelector('audio').readyState >= 3 && !document.querySelector('audio').paused"), 'Discord fixture audio');
    await run("renderPage('settings'); document.getElementById('discord-sharing-toggle').click()");
    await waitFor(() => discordServer.active?.details === 'Fixture Song 1', 'listening activity');
    assert.equal(discordServer.active.type, 2);
    assert.equal(discordServer.active.state, 'Fixture Artist');
    assert.equal(discordServer.active.assets.large_text, 'Fixture Album');
    assert.equal(discordServer.active.assets.large_image, await run('AppState.playerState.coverArt'));
    assert.equal(discordServer.active.timestamps.end - discordServer.active.timestamps.start, 60000);
    assert.doesNotMatch(JSON.stringify(discordServer.active), /trackToken|audioURL|fixture-password|fixture@example/);
    assert.equal(require('../config').getDiscordEnabled(), true);
    await capture('discord-settings');
    await run("document.querySelector('audio').currentTime = 20");
    await waitFor(() => discordServer.active?.timestamps && Math.abs(discordServer.active.timestamps.start - (Date.now() - 20000)) < 6500, 'seek updates presence');
    await run("document.querySelector('audio').pause()");
    await waitFor(() => discordServer.active?.state === 'Paused · Fixture Artist', 'pause keeps the current song');
    assert.equal(discordServer.active.timestamps, undefined, 'Paused activity omits song progress timestamps');
    assert.equal(discordServer.active.details, 'Fixture Song 1');
    assert.ok(discordServer.active.assets.large_image);
    await run('window.api.player.play()');
    await waitFor(() => discordServer.active?.state === 'Fixture Artist' && discordServer.active?.timestamps, 'resume restores progress');
    assert.equal(discordServer.connections.length, 1, 'Seek/pause/resume reuse the live connection');
    await run('window.api.player.next()');
    await waitFor(() => run("AppState.playerState.track === 'Fixture Song 2' && document.querySelector('audio').currentTime > 0"), 'first skip plays');
    // Simulate a missed playing notification, followed by a queued old emptied
    // event. The real audio timeupdates must recover without pause or refocus.
    await run("document.querySelector('audio').addEventListener('playing', e => e.stopImmediatePropagation(), {capture:true, once:true}); window.api.player.next()");
    await waitFor(() => run("AppState.playerState.track === 'Fixture Song 3' && document.querySelector('audio').currentTime > 0.25"), 'second skip plays');
    await run("document.querySelector('audio').dispatchEvent(new Event('emptied'))");
    await waitFor(() => discordServer.active?.details === 'Fixture Song 3', 'consecutive skips publish the latest song');
    assert.equal(discordServer.connections.length, 1, 'Consecutive skips never reconnect');
    await run('window.api.window.toggleMini()');
    assert.ok(discordServer.active, 'Mini mode continues sharing while playing');
    discordServer.connections.at(-1).socket.destroy();
    await waitFor(() => run("discordStatus.status === 'unavailable'"), 'Discord closed');
    assert.equal(await run("document.querySelector('audio').paused"), false, 'Losing Discord never pauses music');
    await run('window.api.window.toggleMini(); window.api.discord.setEnabled(false)');
    await run('window.api.discord.setEnabled(true)');
    await waitFor(() => !!discordServer.active, 'Discord reconnect');
    await run('window.api.player.next()');
    await waitFor(() => discordServer.active?.details === 'Fixture Song 4', 'new song metadata');
    const priorConnectionCount = discordServer.connections.length;
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.reload(); await loaded;
    await waitFor(() => run("typeof AppState !== 'undefined' && AppState.isLoggedIn && discordStatus?.enabled && AppState.stations.length > 0"), 'reload restores settings with sharing already enabled');
    await run("window.api.content.playItem({type:'station', id:'fixture-station'})");
    await waitFor(() => discordServer.connections.length > priorConnectionCount && discordServer.active?.details === 'Fixture Song 1', 'first song shares after reload without toggling the setting');
    await run('window.api.auth.logout()');
    await waitFor(() => !discordServer.active, 'logout clears Discord');
    await discordServer.close(); discordServer = null;
    console.log('Discord opt-in, real IPC, artwork, seek, paused retention, consecutive skips, missed events, mini mode, reconnect, enabled reload and logout passed.');
    console.log('Native player smoke test passed: device takeover, saved thumbs, immediate mode changes and approved auto-resume, Artist Only eligibility, Shuffle exclusion, mode failures and retry.');
    console.log('Daily update checks, elapsed sleep time, wake/focus coalescing, scheduled notices while paused and in mini mode, persistent Later choice, centered pill and local website assets passed.');
    console.log('Screenshots: ' + testData);
    clearTimeout(deadline);
    app.quit();
}).catch(async error => {
    clearTimeout(deadline);
    console.error(error);
    if (discordServer) await discordServer.close();
    app.exit(1);
});
