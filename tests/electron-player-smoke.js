/**
 * Exercise the real renderer, preload and IPC against local HTTPS fixtures.
 * Dialog choices are controlled by this test; no real account is contacted.
 * Run with: electron tests/electron-player-smoke.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session, screen, powerMonitor } = require('electron');

const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'panedora-player-test-'));
app.setPath('userData', testData);
app.disableHardwareAcceleration();
// Exercise the release-only update checker with intercepted network fixtures.
Object.defineProperty(app, 'isPackaged', { value: true });
// Allow the suite's window-movement debounce, real artwork deadlines and Discord rate limits;
// each individual waitFor check still has its own short timeout.
const deadline = setTimeout(() => { console.error('Native player test timed out'); app.exit(1); }, 150000);
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
    let stalledCoverGate = null;
    let stalledCoverRequests = 0;
    let queuedCoverGate = null;
    const artworkRequests = [];
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
        if (['/missing-large.svg', '/refill-missing.svg', '/audio-error.wav'].includes(url.pathname)) {
            return new Response('Unavailable fixture', { status: 503 });
        }
        if (url.pathname === '/held-cover.svg') {
            heldCoverRequests++;
            if (coverGate) await coverGate;
        }
        if (url.pathname === '/stalled-cover.svg') {
            stalledCoverRequests++;
            if (stalledCoverGate) await stalledCoverGate;
        }
        if (url.pathname === '/queued-stalled.svg' && queuedCoverGate) await queuedCoverGate;
        if (url.pathname.endsWith('.svg')) artworkRequests.push(url.pathname + url.search);
        if (url.pathname.endsWith('.svg')) return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="#487ad9"/><circle cx="250" cy="250" r="135" fill="#202947"/><circle cx="250" cy="250" r="26" fill="#a5b9f0"/></svg>',
            { headers: { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*',
                ...(['/held-cover.svg', '/queued-ready.svg', '/refill-ready.svg'].includes(url.pathname) ? { 'Cache-Control': 'no-store' } :
                    url.pathname === '/next-art.svg' ? { 'Cache-Control': 'public, max-age=3600' } : {}) } });
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
    async function exerciseMiniMarqueeClipping() {
        const fullSize = win.getSize();
        const saved = await run('({track: AppState.playerState.track, artist: AppState.playerState.artist})');
        await run("renderPage('home'); window.api.window.toggleMini()");
        await waitFor(() => run("document.body.classList.contains('mini-mode')"), 'mini marquee clipping');
        assert.deepEqual(win.getSize(), [540, 80], 'Mini mode opens at its minimum size');
        assert.deepEqual(win.getMaximumSize(), [900, 80], 'Mini mode has a compact maximum width and fixed height');
        win.setSize(1920, 600);
        await waitFor(() => win.getSize()[0] === 900 && win.getSize()[1] === 80,
            'native constraints stop oversized mini-player resizing at 900px by 80px');
        const paint = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const layout = () => run(`(() => {
            const box = selector => {
                const r = document.querySelector(selector).getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height, center: (r.left + r.right) / 2 };
            };
            const info = document.querySelector('.now-playing-info');
            const style = getComputedStyle(info);
            return { width: innerWidth, height: innerHeight,
                textWidth: info.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                art: box('.now-playing-art'), info: box('.now-playing-info'), thumbs: box('.mini-thumbs'),
                up: box('#mini-thumb-up'), down: box('#mini-thumb-down'),
                playback: box('.control-buttons'), volume: box('.volume-controls') };
        })()`);
        const countTextPixels = (before, after) => {
            let pixels = 0;
            for (let i = 0; i < before.length; i += 4) {
                if ([0, 1, 2].every(channel => after[i + channel] > before[i + channel] + 10)) pixels++;
            }
            return pixels;
        };
        let oldOverlap = 0;
        for (const width of [540, 680, 799, 800, 900]) {
            let collapsedLayout;
            for (const expanded of [false, true]) {
                win.setSize(width, 80);
                win.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
                await run(`document.querySelector('.volume-controls').dispatchEvent(new MouseEvent('${expanded ? 'mouseenter' : 'mouseleave'}'))`);
                await run('new Promise(resolve => setTimeout(resolve, 750))');
                await run(`updatePlayerUI({track: 'WWWW Long scrolling song title WWWW WWWW WWWW WWWW WWWW',
                    artist: 'WWWW Long scrolling artist name WWWW WWWW WWWW WWWW WWWW'})`);
                await paint();
                const currentLayout = await layout();
                assert.equal(currentLayout.width, width);
                assert.equal(currentLayout.height, 80);
                assert.ok(Math.abs(currentLayout.up.top - currentLayout.down.top) < 1,
                    'Thumbs stay side by side');
                assert.ok(currentLayout.thumbs.left - currentLayout.info.right <= 16,
                    'Thumbs stay next to the information instead of drifting across the window');
                assert.ok(currentLayout.playback.left - currentLayout.thumbs.right >= 27,
                    'Thumbs keep comfortable spacing from playback at every size');
                assert.ok(currentLayout.playback.right <= currentLayout.volume.left,
                    'Playback controls stay clear of the expanded volume area');
                if (width >= 680) {
                    assert.ok(currentLayout.playback.left - currentLayout.thumbs.right >= 31,
                        'The thumbs-to-playback gap does not squeeze shut at intermediate widths');
                    assert.ok(Math.abs(currentLayout.playback.center - width / 2) < 1,
                        'Playback is centered as soon as the compact groups have room');
                }
                if (width >= 800) {
                    assert.ok(currentLayout.textWidth >= 150 && currentLayout.textWidth <= 180,
                        'Wide song information stays readable and stops stretching at 180px');
                    if (expanded) {
                        for (const group of ['art', 'info', 'thumbs', 'playback']) {
                            assert.ok(Math.abs(currentLayout[group].left - collapsedLayout[group].left) < 1 &&
                                Math.abs(currentLayout[group].width - collapsedLayout[group].width) < 1,
                            'Opening volume keeps the wide player groups in place: ' + group);
                        }
                    }
                }
                if (!expanded) collapsedLayout = currentLayout;
                // Sample the opaque right edge of the real cover, away from
                // its rounded corners and the animated background behind it.
                const crop = await run(`(() => {
                    const art = document.getElementById('now-playing-art').getBoundingClientRect();
                    return { x: Math.ceil(art.right) - 4, y: Math.ceil(art.top) + 10,
                        width: 4, height: Math.floor(art.height) - 20 };
                })()`);
                for (const phase of [0.25, 0.5]) {
                    await run(`for (const id of ['now-playing-title', 'now-playing-artist']) {
                        const el = document.getElementById(id);
                        if (!el.getAnimations().length) throw new Error(id + ' must scroll in the clipping fixture');
                        for (const animation of el.getAnimations()) {
                            animation.pause();
                            const timing = animation.effect.getTiming();
                            animation.currentTime = timing.delay + timing.duration * ${phase};
                        }
                        el.style.visibility = 'hidden';
                    }`);
                    await paint();
                    const baseline = (await win.webContents.capturePage(crop)).toBitmap();
                    await run("for (const id of ['now-playing-title', 'now-playing-artist']) document.getElementById(id).style.visibility = 'visible'");
                    await paint();
                    const clipped = (await win.webContents.capturePage(crop)).toBitmap();
                    fs.writeFileSync(path.join(testData, `mini-marquee-clipped-${width}-${expanded}-${phase}.png`),
                        (await win.webContents.capturePage()).toPNG());
                    assert.equal(countTextPixels(baseline, clipped), 0,
                        `Scrolling text must stay out of artwork at width=${width}, volumeExpanded=${expanded}, phase=${phase}`);
                    if (!oldOverlap) {
                        // Removing only the new paint clip must reproduce the
                        // old overlap, proving the pixel check can detect it.
                        await run("document.querySelector('.now-playing-info').style.clipPath = 'none'");
                        await paint();
                        oldOverlap = countTextPixels(baseline, (await win.webContents.capturePage(crop)).toBitmap());
                        await run("document.querySelector('.now-playing-info').style.removeProperty('clip-path')");
                        assert.ok(oldOverlap > 0, 'The former clipping must reproduce text pixels inside the cover');
                    }
                }
                if (width === 900) {
                    await run(`for (const id of ['now-playing-title', 'now-playing-artist']) {
                        const element = document.getElementById(id);
                        for (const animation of element.getAnimations()) animation.cancel();
                        element.classList.remove('marquee');
                        element.style.visibility = 'visible';
                    }
                    updatePlayerUI({track: 'Not Playing', artist: '--'})`);
                    await paint();
                    assert.equal(await run(`['now-playing-title', 'now-playing-artist'].every(id => {
                        const element = document.getElementById(id);
                        const range = document.createRange();
                        range.selectNodeContents(element);
                        const text = range.getBoundingClientRect();
                        const info = element.parentElement.getBoundingClientRect();
                        return getComputedStyle(element).visibility === 'visible' && text.width > 0 &&
                            text.left >= info.left + 7 && text.right <= info.right + 1;
                    })`), true, 'The idle labels are visible after resetting the paused marquee fixture');
                    const idleLayout = await layout();
                    const idleTextWidth = await run(`Math.max(...['now-playing-title', 'now-playing-artist'].map(id => {
                        const range = document.createRange();
                        range.selectNodeContents(document.getElementById(id));
                        return range.getBoundingClientRect().width;
                    }))`);
                    assert.ok(idleLayout.textWidth <= idleTextWidth + 1,
                        'Short labels use their natural width instead of reserving blank space before the thumbs');
                    assert.ok(idleLayout.thumbs.left - idleLayout.info.right <= 16,
                        'The thumbs stay beside the short song information');
                    await run("document.querySelector('.now-playing-info').style.flex = '1'");
                    await paint();
                    assert.ok((await layout()).textWidth - idleLayout.textWidth > 50,
                        'Restoring the former flex growth reproduces the large empty space before the thumbs');
                    await run("document.querySelector('.now-playing-info').style.removeProperty('flex')");
                    await paint();
                    assert.ok(idleLayout.playback.left - idleLayout.thumbs.right >= 15,
                        'The empty player also keeps its thumbs separate from playback');
                    console.log(`Short mini-player labels: ${idleLayout.textWidth}px of text, thumbs at ${idleLayout.thumbs.left.toFixed(1)}px, volume expanded=${expanded}.`);
                    assert.equal(await run(`['mini-thumb-up', 'mini-thumb-down'].every(id => {
                        const button = document.getElementById(id);
                        const rect = button.getBoundingClientRect();
                        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === button;
                    })`), true, 'Both mini thumbs remain unobstructed click targets');
                    fs.writeFileSync(path.join(testData, `mini-idle-thumb-spacing-${expanded}.png`),
                        (await win.webContents.capturePage()).toPNG());
                }
            }
        }
        // Check both compact centering points and the former 800px boundary
        // one pixel at a time, in both directions and with both volume states.
        const sizes = [540, ...Array.from({ length: 11 }, (_, i) => 550 + i), 600,
            ...Array.from({ length: 11 }, (_, i) => 640 + i), 680, 740,
            ...Array.from({ length: 11 }, (_, i) => 795 + i), 900];
        const trajectory = [...sizes, ...sizes.slice(0, -1).reverse()];
        let largestPlaybackStep = 0;
        for (const expanded of [false, true]) {
            await run(`document.querySelector('.volume-controls').dispatchEvent(new MouseEvent('${expanded ? 'mouseenter' : 'mouseleave'}'))`);
            await run('new Promise(resolve => setTimeout(resolve, 750))');
            let previous;
            for (const width of trajectory) {
                win.setSize(width, 80);
                await paint();
                const current = await layout();
                assert.equal(current.width, width);
                if (width === 540) {
                    assert.ok(Math.abs(current.playback.center - (expanded ? 277.5 : 322.5)) < 1,
                        'The default-size playback position matches the original compact layout');
                }
                if (width >= 680) {
                    assert.ok(Math.abs(current.playback.center - width / 2) < 1);
                    assert.ok(current.playback.left - current.thumbs.right >= 31,
                        'Resizing never squeezes thumbs back toward the centered playback pill');
                }
                if (previous) {
                    const step = Math.abs(current.width - previous.width);
                    for (const group of ['art', 'info', 'thumbs', 'playback', 'volume']) {
                        assert.ok(Math.abs(current[group].left - previous[group].left) <= step + 1 &&
                            Math.abs(current[group].width - previous[group].width) <= step + 1,
                        `Resizing ${previous.width}px -> ${width}px must not snap ${group}, volumeExpanded=${expanded}`);
                    }
                    if (step === 1) largestPlaybackStep = Math.max(largestPlaybackStep,
                        Math.abs(current.playback.center - previous.playback.center));
                }
                previous = current;
            }
        }
        console.log(`Mini-player resize continuity passed in both directions with volume collapsed/expanded; largest playback movement per 1px resize: ${largestPlaybackStep.toFixed(2)}px.`);
        await run(`for (const id of ['now-playing-title', 'now-playing-artist']) document.getElementById(id).style.removeProperty('visibility');
            updatePlayerUI(${JSON.stringify(saved)}); window.api.window.toggleMini()`);
        await waitFor(() => !win.webContents.isLoading() && win.getSize()[1] === fullSize[1], 'full-player size restored');
        assert.deepEqual(win.getSize(), fullSize);
        win.setSize(fullSize[0] + 60, fullSize[1] + 60);
        await waitFor(() => win.getSize()[0] === fullSize[0] + 60 && win.getSize()[1] === fullSize[1] + 60,
            'full player can resize in both directions beyond the mini-player limits');
        win.setSize(...fullSize);
        console.log(`Mini-player layout and marquee clipping passed at 540/680/799/800/900px: wide playback centered, horizontal thumbs beside bounded text, volume expansion stable, native mini size limited to 540–900px by 80px, full size constraints restored; removing the clip reproduced ${oldOverlap} artwork pixels.`);
    }
    async function exerciseClassicMiniplayer() {
        const minHeight = 500; // Fixed compact size: 12px margins around every row.
        const fullSize = win.getSize();
        const saved = await run('JSON.parse(JSON.stringify(AppState.playerState))');
        const savedEffect = await run('AppState.currentEffect');
        const track = 'A Song Title Long Enough To Need Truncating In A Narrow Window';
        const history = [
            { trackToken: 'classic-h1', songTitle: 'First song', artistName: 'First artist', feedback: null },
            { trackToken: 'classic-h2', songTitle: 'Second song', artistName: 'Second artist', feedback: 'liked' },
            { trackToken: 'classic-now', songTitle: track, artistName: 'Current artist' }
        ];
        const box = selector => run(`(() => {
            const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
                center: (r.left + r.right) / 2 };
        })()`);

        // The classic player is opt-in: the default setting keeps the wide mini player.
        assert.equal(await run('window.api.settings.getLegacyMiniplayer()'), false, 'Legacy miniplayer is off by default');
        assert.equal(await run('window.api.settings.setLegacyMiniplayer(true)'), true);
        await run(`renderPage('home'); updatePlayerUI({ trackToken: 'classic-now', track: ${JSON.stringify(track)},
            artist: 'Current artist', album: 'Current album', isPlaying: true, feedback: 'thumbUp', history: ${JSON.stringify(history)} });
            applyBgEffect('reactive-bars'); window.api.window.toggleMini()`);
        await waitFor(() => run("document.body.classList.contains('classic-mini')"), 'classic mini player');
        assert.deepEqual(win.getSize(), [280, minHeight], 'The classic player opens at its minimum size');
        assert.deepEqual(win.getMinimumSize(), [280, minHeight]);
        assert.deepEqual(win.getMaximumSize(), [280, minHeight]);
        assert.equal(await run("document.body.classList.contains('mini-mode')"), true);
        assert.equal(await run("getComputedStyle(document.querySelector('.player-footer')).display"), 'none',
            'The wide mini player footer is replaced');

        // The mode IPC can arrive before the native resize reaches the renderer.
        await waitFor(() => run(`innerWidth === 280 && innerHeight === ${minHeight}`), 'classic viewport resized');

        // Layout at the minimum size: 12px margins, a 256px cover, frosted details, progress, controls and the button row.
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} vs ${expected}`);
        const art = await box('#classic-art');
        near(art.width, 256, 'cover width'); near(art.height, 256, 'cover height');
        near(art.top, 12, 'cover top margin'); near(art.left, 12, 'cover left margin');
        near(280 - art.right, 12, 'cover right margin');
        const info = await box('.classic-info');
        near(info.left, art.left, 'details box lines up with the cover (left)');
        near(info.right, art.right, 'details box lines up with the cover (right)');
        near(info.top - art.bottom, 12, 'margin between cover and details');
        const lines = {};
        for (const name of ['artist', 'track', 'album']) lines[name] = await box('#classic-' + name);
        const fonts = await run(`Object.fromEntries(['artist', 'track', 'album'].map(name => {
            const style = getComputedStyle(document.getElementById('classic-' + name));
            return [name, [style.fontSize, style.fontWeight, style.textAlign]];
        }))`);
        assert.deepEqual(fonts, { artist: ['16px', '400', 'center'], track: ['16px', '700', 'center'], album: ['16px', '400', 'center'] },
            '12pt centered text: artist and album normal, track bold');
        const glass = await run(`(() => {
            const info = getComputedStyle(document.querySelector('.classic-info'));
            const footer = getComputedStyle(document.querySelector('.player-footer'));
            // The footer is hidden, so compare with the full player's declared glass values.
            const root = getComputedStyle(document.documentElement);
            return { background: info.backgroundColor, glass: root.getPropertyValue('--glass').trim(),
                blur: info.backdropFilter, blurValue: root.getPropertyValue('--blur').trim(),
                border: info.borderTopColor, borderValue: root.getPropertyValue('--glass-border').trim(),
                footerBlur: footer.backdropFilter };
        })()`);
        assert.equal(glass.blur, `blur(${parseFloat(glass.blurValue) + 2}px)`, 'The full player blur plus 2px');
        // Chromium stores alpha in 8 bits, so 0.045 reads back as 0.043.
        const alpha = value => parseFloat(value.replace(/\s/g, '').split(',')[3]);
        assert.ok(glass.background.startsWith('rgba(255, 255, 255,') && Math.abs(alpha(glass.background) - alpha(glass.glass)) < 0.003,
            'Uses the full player glass color: ' + JSON.stringify(glass));
        assert.ok(glass.border.replace(/\s/g, '').startsWith('rgba(255,255,255,0.07'), 'Uses the full player glass border');
        const tint = await run(`(() => { const s = getComputedStyle(document.querySelector('.classic-info'));
            return { image: s.backgroundImage, color: s.backgroundColor }; })()`);
        assert.match(tint.image, /linear-gradient\(rgba\(8, 8, 12, 0\.16/, 'A light smoky tint darkens the glass');
        assert.ok(tint.color.startsWith('rgba(255, 255, 255,'), 'The full player glass colour is still underneath');
        const timeAlpha = await run(`parseFloat(getComputedStyle(document.getElementById('classic-current-time')).color.split(',')[3])`);
        assert.ok(timeAlpha >= 0.7, 'Times are easier to read than the full player\u2019s faint labels: ' + timeAlpha);
        assert.ok(lines.artist.top >= info.top && lines.track.top >= lines.artist.bottom - 1 &&
            lines.album.top >= lines.track.bottom - 1 && lines.album.bottom <= info.bottom, 'Artist, track and album stack inside the details box');
        near(lines.artist.center, info.center, 'text is centered in the box');
        // A long title scrolls inside its box (like the wide mini player) instead of being cut off.
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const marquee = await run(`(() => {
            const info = id => { const line = document.getElementById(id), inner = line.querySelector('.classic-line-text');
                const style = getComputedStyle(inner);
                return { overflows: inner.scrollWidth > line.clientWidth, scrolls: inner.classList.contains('marquee'),
                    animation: style.animationName, wraps: inner.getBoundingClientRect().height > 24,
                    offset: inner.style.getPropertyValue('--marquee-offset') }; };
            return { track: info('classic-track'), artist: info('classic-artist'), album: info('classic-album') };
        })()`);
        assert.equal(marquee.track.overflows, true, 'The long title is wider than its box');
        assert.equal(marquee.track.scrolls, true, 'so it scrolls');
        assert.equal(marquee.track.animation, 'marquee-scroll');
        assert.ok(parseFloat(marquee.track.offset) < 0, 'toward its end: ' + marquee.track.offset);
        assert.equal(marquee.track.wraps, false, 'and never wraps onto a second line');
        assert.deepEqual([marquee.artist.scrolls, marquee.album.scrolls], [false, false], 'Lines that fit stay still');
        // While scrolling, the box keeps clipping the text instead of letting it spill outside the details box.
        assert.equal(await run("getComputedStyle(document.getElementById('classic-track')).overflow"), 'hidden');
        // Only the album art and its margin drag the window: the band ends where the details box begins.
        const dragBand = await box('.classic-drag');
        near(dragBand.top, 0, 'drag band starts at the top of the window');
        near(dragBand.left, 0, 'drag band starts at the left edge'); near(dragBand.width, 280, 'drag band spans the window width');
        near(dragBand.bottom, info.top, 'drag band ends exactly where the details box begins');
        assert.ok(dragBand.bottom >= art.bottom + 11, 'and includes the margin under the cover');
        const regions = await run(`Object.fromEntries(['.classic-drag', '.classic-art', '.classic-info', '.classic-progress',
            '.classic-controls button', '.classic-bottom button', '.classic-volume-slider', '.classic-player'].map(selector =>
            [selector, getComputedStyle(document.querySelector(selector)).getPropertyValue('-webkit-app-region')]))`);
        assert.equal(regions['.classic-drag'], 'drag');
        for (const selector of ['.classic-info', '.classic-player']) {
            assert.notEqual(regions[selector], 'drag', selector + ' must not drag the window');
        }
        for (const selector of ['.classic-progress', '.classic-controls button', '.classic-bottom button', '.classic-volume-slider']) {
            assert.equal(regions[selector], 'no-drag', selector + ' is explicitly not draggable');
        }
        const progress = await box('.classic-progress');
        near(progress.top - info.bottom, 12, 'margin between details and progress bar');
        near(progress.width, 256, 'progress row lines up with the cover');
        const controls = await box('.classic-controls');
        near(controls.center, 140, 'play controls are centered');
        near(controls.top - progress.bottom, 12, 'margin between progress bar and controls');
        const barStyle = await run(`(() => {
            const classic = getComputedStyle(document.getElementById('classic-progress-bar'));
            const footer = document.getElementById('progress-bar');
            const fill = getComputedStyle(document.getElementById('classic-progress-fill'));
            return { height: classic.height, background: classic.backgroundColor, radius: classic.borderTopLeftRadius,
                fill: fill.backgroundImage.slice(0, 15), sameClass: footer.className === document.getElementById('classic-progress-bar').className };
        })()`);
        assert.equal(barStyle.sameClass, true, 'Same progress bar class as the full player');
        assert.equal(barStyle.height, '3px');
        assert.ok(barStyle.fill.startsWith('linear-gradient'), 'Same accent gradient fill as the full player');
        // The bar mirrors the footer's position and times, and a click seeks like the footer bar.
        await run(`DOM.progressFill.style.width = '40%'; DOM.currentTime.textContent = '1:23'; DOM.totalTime.textContent = '3:30'; syncClassicProgress()`);
        assert.deepEqual(await run(`[document.getElementById('classic-progress-fill').style.width,
            document.getElementById('classic-current-time').textContent, document.getElementById('classic-total-time').textContent,
            document.getElementById('classic-progress-bar').getAttribute('aria-valuenow')]`), ['40%', '1:23', '3:30', '40']);
        // Prev/play/next are the full player's controls, so they follow the colour theme.
        const controlStyle = () => run(`(() => {
            const classic = getComputedStyle(document.getElementById('classic-play'));
            const footer = getComputedStyle(document.getElementById('play-pause-btn'));
            const prev = document.getElementById('classic-prev').getBoundingClientRect();
            const play = document.getElementById('classic-play').getBoundingClientRect();
            return { classic: classic.backgroundImage, footer: footer.backgroundImage, glow: classic.boxShadow,
                play: [play.width, play.height], prev: [prev.width, prev.height],
                playClass: document.getElementById('classic-play').className, prevClass: document.getElementById('classic-prev').className };
        })()`);
        const themed = await controlStyle();
        assert.equal(themed.playClass, 'play-pause-btn');
        assert.equal(themed.prevClass, 'control-btn');
        assert.deepEqual([themed.play, themed.prev], [[40, 40], [32, 32]], 'Same sizes as the full player');
        assert.equal(themed.classic, themed.footer);
        assert.ok(themed.classic.startsWith('linear-gradient') && themed.glow !== 'none', 'Accent gradient and glow');
        const otherTheme = await run("Object.keys(THEMES).find(id => id !== (AppState.currentTheme || localStorage.getItem('panedora-theme') || 'midnight'))");
        const originalTheme = await run("AppState.currentTheme || localStorage.getItem('panedora-theme') || 'midnight'");
        await run(`applyTheme(${JSON.stringify(otherTheme)})`);
        const recoloured = await controlStyle();
        assert.notEqual(recoloured.classic, themed.classic, 'The play button changes with the colour theme');
        assert.equal(recoloured.classic, recoloured.footer);
        await run(`applyTheme(${JSON.stringify(originalTheme)})`);
        const bottom = await box('.classic-bottom');
        const thumbs = await box('.classic-thumbs');
        const center = await box('.classic-center');
        const volume = await box('.classic-volume');
        const sizes = await run(`({ thumb: document.getElementById('classic-thumb-up').getBoundingClientRect().width,
            expand: document.getElementById('classic-expand').getBoundingClientRect().width,
            history: document.getElementById('classic-history-btn').getBoundingClientRect().width })`);
        assert.ok(sizes.expand > 28 && sizes.expand <= 34, 'Centre buttons are a touch bigger than before: ' + sizes.expand);
        assert.ok(sizes.thumb > sizes.expand && sizes.thumb <= 42, 'Thumbs are larger than the other buttons, but not huge: ' + sizes.thumb);
        assert.ok(bottom.top - controls.bottom >= 12 - 1, 'Controls keep their margin above the button row');
        near(thumbs.left, 12, 'thumbs sit at the left'); near(volume.right, 268, 'volume sits at the right');
        // The whole volume knob is clickable: points on its top and bottom edge hit the slider.
        const knob = await run(`(() => {
            const slider = document.getElementById('classic-volume-slider');
            const r = slider.getBoundingClientRect();
            const centreY = r.top + r.height / 2;
            const knobX = r.left + 7 + (slider.value / 100) * (r.width - 14); // 14px knob
            const hit = y => document.elementFromPoint(knobX, y) === slider;
            return { width: r.width, height: r.height, top: hit(centreY - 6.5), bottom: hit(centreY + 6.5), centre: hit(centreY),
                aboveBox: hit(r.top - 3) };
        })()`);
        assert.ok(knob.width >= 60 && knob.height >= 18 && knob.height <= 20, `The slider is larger than before, but only just taller than the knob: ${knob.width}x${knob.height}`);
        assert.deepEqual([knob.centre, knob.top, knob.bottom], [true, true, true], 'The top and bottom of the 14px knob are inside the slider');
        assert.equal(knob.aboveBox, false, 'but the slider does not reach far past the knob');
        near(center.center, 140, 'mini and history buttons are centered');
        // Every icon is vertically centred on the row (the mini-player icon used to sit too high).
        const iconOffsets = await run(`(() => {
            const row = document.querySelector('.classic-bottom').getBoundingClientRect();
            const rowCenter = row.top + row.height / 2;
            const offsets = {};
            const icons = { thumbUp: '#classic-thumb-up svg', thumbDown: '#classic-thumb-down svg', miniPlayer: '#classic-expand svg',
                history: '#classic-history-btn svg', volume: '.classic-volume-icon' };
            for (const [name, selector] of Object.entries(icons)) {
                const svg = document.querySelector(selector);
                const rect = svg.getBoundingClientRect();
                const content = svg.getBBox();
                offsets[name] = +(rect.top + (content.y + content.height / 2) * rect.height / 24 - rowCenter).toFixed(2);
            }
            return offsets;
        })()`);
        for (const [name, offset] of Object.entries(iconOffsets)) {
            assert.ok(Math.abs(offset) <= 0.75, `${name} icon is centred on the button row: ${JSON.stringify(iconOffsets)}`);
        }
        assert.equal(await run("document.getElementById('classic-history-btn').title"), 'History');
        assert.equal(await run("document.querySelector('#classic-history-btn svg path').getAttribute('d').startsWith('M5.07 16A8 8')"), true,
            'History uses the backwards-arrow clock');
        assert.ok(thumbs.right <= center.left && center.right <= volume.left, 'Thumbs, centre buttons and volume do not overlap');
        assert.ok(bottom.bottom <= minHeight - 12 + 1, `Everything fits inside ${minHeight}px with the margin kept: ${bottom.bottom}`);
        assert.equal(await run("document.getElementById('classic-thumb-up').classList.contains('liked')"), true,
            'A thumbed song is shown the same way as in the wide mini player');
        assert.equal(await run("document.getElementById('classic-play').getAttribute('aria-label')"), 'Pause');
        // The visualizer still fills the window behind the controls.
        const canvas = await box('#reactive-canvas');
        near(canvas.width, 280, 'visualizer canvas width'); near(canvas.height, minHeight, 'visualizer canvas height');
        await capture('classic-mini');

        // History replaces the cover and keeps the full player's rows and thumbs.
        await run("document.getElementById('classic-history-btn').click()");
        assert.equal(await run("document.getElementById('classic-history').hidden"), false);
        assert.equal(await run("document.getElementById('classic-history-btn').getAttribute('aria-expanded')"), 'true');
        assert.equal(await run("document.querySelectorAll('#classic-history .history-item').length"), 2,
            'The playing song is not part of its own history');
        assert.equal(await run("document.querySelectorAll('#classic-history .history-thumb-btn').length"), 4);
        assert.equal(await run("document.querySelector('#classic-history .history-thumb-up.liked') !== null"), true);
        const panel = await box('#classic-history');
        assert.ok(panel.top >= 11 && panel.bottom <= progress.top + 1 && panel.width >= 250, 'History fills the cover and details area');
        await capture('classic-mini-history');
        await run("document.getElementById('classic-history-btn').click()");
        assert.equal(await run("document.getElementById('classic-history').hidden"), true);

        // Neither shrinking nor stretching can separate the compact artwork and controls.
        win.setSize(200, 300);
        await waitFor(() => win.getSize()[0] === 280 && win.getSize()[1] === minHeight, 'classic player cannot shrink below its minimum size');
        win.setSize(420, 760);
        await waitFor(() => win.getSize()[0] === 280 && win.getSize()[1] === minHeight, 'classic player stays compact when enlarged');
        await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const wideArt = await box('#classic-art');
        near(wideArt.width, 256, 'cover keeps its size'); near(wideArt.center, 140, 'cover stays centered');
        near((await box('.classic-bottom')).bottom, minHeight - 12, 'button row stays beside the play controls');
        await capture('classic-mini-resize-limited');
        win.setSize(280, minHeight);
        await waitFor(() => win.getSize()[0] === 280 && win.getSize()[1] === minHeight, 'classic minimum size');

        // It remembers where it was left: move it, leave, and come back.
        win.setPosition(120, 90);
        await waitFor(() => {
            const saved = require('../config').getClassicMiniBounds();
            return saved && saved.x === 120 && saved.y === 90;
        }, 'classic player position saved after moving it');
        assert.deepEqual(require('../config').getClassicMiniBounds(), { x: 120, y: 90, width: 280, height: minHeight });

        // Back to the full player from the classic controls.
        await run("document.getElementById('classic-expand').click()");
        await waitFor(() => run("!document.body.classList.contains('mini-mode')"), 'leaving the classic player');
        assert.equal(await run("document.body.classList.contains('classic-mini')"), false);
        await waitFor(() => !win.webContents.isLoading() && win.getSize()[1] === fullSize[1], 'full-player size restored');
        assert.deepEqual(win.getSize(), fullSize);
        assert.deepEqual(win.getMinimumSize(), [900, 600]);
        assert.equal(win.isResizable(), true, 'The full player becomes resizable again');
        await run('window.api.window.toggleMini()');
        await waitFor(() => run("document.body.classList.contains('classic-mini')"), 'classic player reopened');
        assert.deepEqual(win.getBounds(), { x: 120, y: 90, width: 280, height: minHeight }, 'The classic player reopens where it was left');
        await run("document.getElementById('classic-expand').click()");
        await waitFor(() => run("!document.body.classList.contains('mini-mode')"), 'leaving the reopened classic player');
        await waitFor(() => !win.webContents.isLoading() && win.getSize()[1] === fullSize[1], 'full-player size restored after reopening');

        // Turning the setting off restores the wide mini player.
        assert.equal(await run('window.api.settings.setLegacyMiniplayer(false)'), false);
        await run('window.api.window.toggleMini()');
        await waitFor(() => run("document.body.classList.contains('mini-mode')"), 'wide mini player');
        assert.equal(await run("document.body.classList.contains('classic-mini')"), false);
        assert.deepEqual(win.getSize(), [540, 80]);
        await run(`window.api.window.toggleMini(); applyBgEffect(${JSON.stringify(savedEffect)}); updatePlayerUI(${JSON.stringify(saved)})`);
        await waitFor(() => !win.webContents.isLoading() && win.getSize()[1] === fullSize[1], 'full-player size restored again');
        console.log('Classic mini player passed: opt-in setting, fixed 280x' + minHeight + ' compact size, 256px cover with 12px margins, frosted centered 12pt artist/track/album box, full-player progress bar, centered controls, enlarged thumbs/history/volume row, history view, background visualizer canvas, and return to the resizable full and wide mini players.');
    }
    async function exerciseVolumeMemory() {
        const initial = await run("Number(document.getElementById('volume-slider').value)");
        await run("renderPage('settings')");
        assert.equal(await run("document.getElementById('remember-volume-toggle') === null"), true,
            'Volume memory has no settings toggle');
        for (const volume of [37, 0, initial]) {
            await run(`(() => {
                const slider = document.getElementById('volume-slider');
                slider.value = '${volume}';
                slider.dispatchEvent(new Event('input', { bubbles: true }));
                slider.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
            await waitFor(() => require('../config').getVolumeSettings().volume === volume,
                'volume saved automatically: ' + volume);
            assert.deepEqual(await run('window.api.settings.getVolume()'), { volume });
            assert.equal(await run("Number(document.getElementById('classic-volume-slider').value)"), volume);
        }
        await run('new Promise(resolve => setTimeout(resolve, 750))');
        await capture('player-settings');
        await run("renderPage('home')");
        console.log('Automatic volume memory passed: no toggle, saved slider changes and mute through real IPC, both sliders synchronized.');
    }

    async function exerciseMiniScreenBounds() {
        const fullBounds = win.getBounds();
        for (const legacy of [false, true]) {
            await run(`window.api.settings.setLegacyMiniplayer(${legacy})`);
            await run('window.api.window.toggleMini()');
            await waitFor(() => run("document.body.classList.contains('mini-mode')"), 'mini mode for screen bounds');
            if (!legacy) win.setSize(900, 80);
            const size = win.getSize();
            const area = screen.getDisplayMatching(win.getBounds()).workArea;
            const maxX = area.x + area.width - size[0];
            const maxY = area.y + area.height - size[1];
            for (const [x, y, expectedX, expectedY] of [
                [area.x - 64, area.y + 40, area.x, area.y + 40],
                [maxX + 64, area.y + 40, maxX, area.y + 40],
                [area.x + 40, maxY + 64, area.x + 40, maxY],
                [area.x + 40, area.y - 64, area.x + 40, area.y]
            ]) {
                win.setPosition(x, y);
                await waitFor(() => {
                    const bounds = win.getBounds();
                    return bounds.x === expectedX && bounds.y === expectedY;
                }, `${legacy ? 'classic' : 'wide'} mini player returns fully on screen`);
                assert.deepEqual(win.getSize(), size, 'Position correction never changes player size');
                if (legacy) {
                    await waitFor(() => {
                        const saved = require('../config').getClassicMiniBounds();
                        return saved?.x === expectedX && saved?.y === expectedY;
                    }, 'corrected classic position saved');
                }
            }
            await capture(legacy ? 'classic-mini-on-screen' : 'wide-mini-on-screen');
            await run('window.api.window.toggleMini()');
            await waitFor(() => run("!document.body.classList.contains('mini-mode')"), 'full player after screen bounds');
            assert.deepEqual(win.getBounds(), fullBounds, 'The full player restores its original position and size');
        }
        await run('window.api.settings.setLegacyMiniplayer(false)');
        console.log('Mini-player screen edges passed: both layouts return inside all four work-area edges without resizing; classic positions saved after correction, full bounds restored.');
    }

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
        await waitFor(() => run("AppState.playerState.stationModes.status === 'ready'"), 'station metadata settles');
        await waitFor(() => run("upcomingArtworkPreloads.get('https://fixture.invalid/next-art.svg')?.complete && upcomingArtworkPreloads.get('https://fixture.invalid/next-art.svg').naturalWidth > 0"), 'next song cover downloads while the first song is still playing');
        const warmedRequests = artworkRequests.filter(url => url === '/next-art.svg').length;
        assert.equal(warmedRequests, 1);

        let finishStalledCover;
        stalledCoverGate = new Promise(resolve => { finishStalledCover = resolve; });
        await run("updatePlayerUI({ coverArt: 'https://fixture.invalid/stalled-cover.svg', coverArtSources: ['https://fixture.invalid/recovered-cover.svg'] })");
        await waitFor(() => stalledCoverRequests > 0, 'stalled artwork request');
        assert.equal(await run("document.getElementById('now-playing-art').getAttribute('src') === 'https://fixture.invalid/stalled-cover.svg' && !document.getElementById('now-playing-art').complete"), true, 'The new cover is requested immediately while its response is held');
        await waitFor(() => run("['now-playing-art', 'np-large-art'].every(id => { const image = document.getElementById(id); return image.currentSrc === 'https://fixture.invalid/recovered-cover.svg' && image.complete && image.naturalWidth > 0; })"), 'both players recover stalled artwork without an error event', 8000);
        finishStalledCover();
        stalledCoverGate = null;
        await run('new Promise(resolve => setTimeout(resolve, 150))');
        assert.equal(await run("['now-playing-art', 'np-large-art'].every(id => document.getElementById(id).currentSrc === 'https://fixture.invalid/recovered-cover.svg')"), true, 'A late stalled response cannot replace the recovered image');

        let finishAudio;
        let finishRefill;
        slowAudioGate = new Promise(resolve => { finishAudio = resolve; });
        refillGate = new Promise(resolve => { finishRefill = resolve; });
        const fragmentsBefore = calls.filter(c => c.path.endsWith('/getFragment')).length;
        await run('nextPlayerTrack()');
        await waitFor(() => audioRequests.includes('/slow-audio.wav'), 'second song starts loading');
        await waitFor(() => run("document.getElementById('now-playing-art').currentSrc === 'https://fixture.invalid/next-art.svg' && document.getElementById('now-playing-art').complete"), 'the prefetched cover displays while the next audio is still buffering');
        assert.equal(artworkRequests.filter(url => url === '/next-art.svg').length, warmedRequests, 'The cached upcoming cover is reused without downloading it again');
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
        console.log('Direct artwork loading, queued cover prefetch/cache reuse, stalled artwork fallback, rapid skips, slow audio and playlist responses, real natural song endings, stale error recovery, first-song artwork recovery and clearing missing covers passed.');
    }

    async function exerciseNaturalMiniArtwork(legacy = false) {
        const previousEffect = await run('AppState.currentEffect');
        const suffix = legacy ? '?classic' : '';
        const artId = legacy ? 'classic-art' : 'now-playing-art';
        const effect = legacy ? 'reactive-bars' : 'reactive-wave';
        await run(`window.api.settings.setLegacyMiniplayer(${legacy})`);
        await run(`renderPage('home'); successfulArtworkSources.clear(); applyBgEffect('${effect}'); window.api.window.toggleMini()`);
        await waitFor(() => run("document.body.classList.contains('mini-mode')"), 'mini mode for natural endings');
        let finishQueuedCover;
        let finishRefill;
        queuedCoverGate = new Promise(resolve => { finishQueuedCover = resolve; });
        refillGate = new Promise(resolve => { finishRefill = resolve; });
        stressTracks = tracks.slice(0, 2).map((track, index) => ({ ...track, trackToken: 'mini-natural-' + index,
            albumArt: index === 0 ? art : [
                { size: 1080, url: 'https://fixture.invalid/queued-stalled.svg' + suffix },
                { size: 500, url: 'https://fixture.invalid/queued-ready.svg' + suffix }
            ] }));
        // Count the player's fallback independently of the OS media session,
        // which can fetch the primary artwork URL for its own controls.
        freshTracks = tracks.slice(0, 2).map((track, index) => ({ ...track, trackToken: 'mini-refill-' + index,
            albumArt: [{ size: 1080, url: 'https://fixture.invalid/refill-missing.svg' + suffix },
                { size: 500, url: 'https://fixture.invalid/refill-ready.svg' + suffix }] }));
        await run("window.api.content.playItem({type:'station', id:'fixture-station'})");
        await waitFor(() => run("AppState.playerState.trackToken === 'mini-natural-0' && !document.querySelector('audio').paused"), 'first song plays in mini mode');
        await waitFor(() => run(`
            window.preparedMiniCover = upcomingArtworkPreloads.get('https://fixture.invalid/queued-stalled.svg${suffix}');
            window.preparedMiniCover?.complete && window.preparedMiniCover.naturalWidth > 0 &&
                window.preparedMiniCover.currentSrc === 'https://fixture.invalid/queued-ready.svg${suffix}';
        `), 'stalled queued cover recovers before the current song ends', 8000);
        assert.equal(artworkRequests.filter(url => url === '/queued-ready.svg' + suffix).length, 1);
        await run(`
            window.naturalArtworkEvents = [];
            window.captureNaturalArtwork = () => {
                const image = document.getElementById('${artId}');
                window.naturalArtworkEvents.push({ token: AppState.playerState.trackToken,
                    ready: image.complete && image.naturalWidth > 0,
                    source: image.currentSrc, prepared: image === window.preparedMiniCover });
            };
            document.querySelector('audio').addEventListener('playing', window.captureNaturalArtwork);
        `);
        const endNaturally = async () => {
            await waitFor(() => run("Number.isFinite(document.querySelector('audio').duration) && document.querySelector('audio').duration > 0"), 'natural-ending duration');
            await run("document.querySelector('audio').currentTime = document.querySelector('audio').duration - 0.08");
        };
        await endNaturally();
        await waitFor(() => run("window.naturalArtworkEvents.some(event => event.token === 'mini-natural-1')"), 'second song starts from a real ended event');
        assert.deepEqual(await run("window.naturalArtworkEvents.find(event => event.token === 'mini-natural-1')"), {
            token: 'mini-natural-1', ready: true, source: 'https://fixture.invalid/queued-ready.svg' + suffix, prepared: true
        }, 'The recovered mini cover is already displayed when the next song starts');
        assert.equal(artworkRequests.filter(url => url === '/queued-ready.svg' + suffix).length, 1, 'Even a no-store cover is reused without a second download');

        finishRefill();
        refillGate = null;
        await waitFor(() => run(`
            window.preparedMiniCover = upcomingArtworkPreloads.get('https://fixture.invalid/refill-missing.svg${suffix}');
            window.preparedMiniCover?.complete && window.preparedMiniCover.naturalWidth > 0 &&
                window.preparedMiniCover.currentSrc === 'https://fixture.invalid/refill-ready.svg${suffix}';
        `), 'refilled cover preloads before the last queued song ends');
        assert.equal(await run('AppState.playerState.trackToken'), 'mini-natural-1');
        await endNaturally();
        await waitFor(() => run("window.naturalArtworkEvents.some(event => event.token === 'mini-refill-0')"), 'refilled song starts naturally');
        assert.deepEqual(await run("window.naturalArtworkEvents.find(event => event.token === 'mini-refill-0')"), {
            token: 'mini-refill-0', ready: true, source: 'https://fixture.invalid/refill-ready.svg' + suffix, prepared: true
        });
        assert.equal(artworkRequests.filter(url => url === '/refill-ready.svg' + suffix).length, 1);
        assert.equal(await run(`window.visualizer.isVisualizing && window.visualizer.style === '${legacy ? 'bars' : 'wave'}'`), true,
            'Natural transitions keep the reactive mini-player background running');
        finishQueuedCover();
        queuedCoverGate = null;
        await capture(legacy ? 'natural-ending-classic-artwork' : 'natural-ending-mini-artwork');
        assert.equal(await run(`document.getElementById('${artId}').currentSrc`), 'https://fixture.invalid/refill-ready.svg' + suffix, 'Late stalled artwork cannot restore an earlier song');
        await run("document.querySelector('audio').removeEventListener('playing', window.captureNaturalArtwork); window.api.window.toggleMini()");
        assert.equal(await run("document.getElementById('now-playing-art') === window.preparedMiniCover"), true,
            'Returning to the full player preserves the decoded image');
        await run("document.getElementById('now-playing-art').click()");
        await waitFor(() => run(`AppState.currentPage === 'nowplaying' && document.getElementById('np-large-art').complete && document.getElementById('np-large-art').currentSrc === 'https://fixture.invalid/refill-ready.svg${suffix}'`), 'promoted cover still opens the full player');
        await run(`applyBgEffect(${JSON.stringify(previousEffect || 'aurora')})`);
        stressTracks = freshTracks = null;
        const historyCoverReady = (token, url) => run(`(() => {
            const image = document.querySelector('.history-item[data-token="${token}"] .history-art');
            return image?.complete && image.naturalWidth > 0 && image.currentSrc === '${url}';
        })()`);
        await waitFor(() => historyCoverReady('mini-natural-1', 'https://fixture.invalid/queued-ready.svg' + suffix),
            'opening history reuses the cover that recovered during mini playback');
        await endNaturally();
        await waitFor(() => run("AppState.playerState.trackToken === 'mini-refill-1'"), 'next natural ending with history open');
        await waitFor(() => historyCoverReady('mini-refill-0', 'https://fixture.invalid/refill-ready.svg' + suffix),
            'live history uses the working fallback after a song with unavailable primary artwork ends');
        await capture(legacy ? 'recovered-classic-history-artwork' : 'recovered-history-artwork');
        await run('window.api.settings.setLegacyMiniplayer(false)');
        console.log('Natural endings in ' + (legacy ? 'classic' : 'wide') + ' mini mode passed: stalled preload fallback, no-store image reuse at audio start, early refill artwork, late responses, full-player expansion and recovered artwork in initial/live history.');
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
    assert.equal(await run("document.getElementById('update-current-version').textContent"), app.getVersion());
    assert.equal(await run("document.getElementById('update-available-version').textContent"), '99.0.0');
    assert.equal(await run("document.getElementById('update-version-range').textContent"), `${app.getVersion()} → 99.0.0`);
    assert.equal(await run("document.getElementById('update-banner').getBoundingClientRect().width <= 390 && document.getElementById('update-banner').getBoundingClientRect().height < 50"), true, 'Update pill remains compact');
    assert.equal(await run("document.getElementById('update-banner').scrollHeight <= document.getElementById('update-banner').clientHeight"), true, 'Update banner has no clipping or scrolling');
    assert.equal(await run("document.getElementById('update-message').scrollWidth <= document.getElementById('update-message').clientWidth"), true, 'Installed and available versions are fully visible');
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
    assert.equal(await run("document.getElementById('update-message').scrollWidth <= document.getElementById('update-message').clientWidth"), true, 'Both versions remain fully visible at the minimum window size');
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
    await exerciseVolumeMemory();
    await exerciseMiniMarqueeClipping();
    await exerciseClassicMiniplayer();
    await exerciseMiniScreenBounds();
    await exerciseQueuedPlayback();
    await exerciseNaturalMiniArtwork();
    await exerciseNaturalMiniArtwork(true);
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
