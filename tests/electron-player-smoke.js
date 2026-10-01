/**
 * Exercise the real renderer, preload and IPC against local HTTPS fixtures.
 * Dialog choices are controlled by this test; no real account is contacted.
 * Run with: electron tests/electron-player-smoke.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog, session } = require('electron');

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
    const calls = [];
    const prompts = [];
    const art = [{ size: 500, url: 'https://fixture.invalid/art.svg' }];
    const audio = silentWav();
    const tracks = [1, 2, 3, 4].map(n => ({
        trackToken: 'fixture-track-' + n, songTitle: 'Fixture Song ' + n,
        artistName: 'Fixture Artist', albumTitle: 'Fixture Album', albumArt: art,
        audioURL: 'https://fixture.invalid/audio-' + n + '.wav', trackLength: 60,
        rating: n === 1 ? 1 : n === 2 ? '1' : 0
    }));
    dialog.showMessageBox = (parent, options) => new Promise(resolve => prompts.push({ parent, options, resolve }));
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
                return json({ authToken: 'fixture-token', config: { branding: 'PandoraPlus' } });
            case '/api/v1/station/getStations':
                return json({ stations: [{ stationId: 'fixture-station', name: 'Fixture Station', art }] });
            case '/api/v1/search/fullSearch':
                return json({ items: [{ type: 'TR', pandoraId: 'TR:fixture', songTitle: 'Fixture Song', artistName: 'Fixture Artist', albumArt: art }] });
            case '/api/v1/playlist/getFragment':
                return canStream ? json({ tracks }) : json({ errorString: 'STREAM_VIOLATION' }, 429);
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
    await waitFor(() => run('AppState.stations.length === 1'), 'station collection');

    await run("AppState.searchQuery = 'fixture'; renderPage('search'); window.api.content.search('fixture')");
    await waitFor(() => run("document.querySelector('#search-songs img')?.naturalWidth > 0"), 'search artwork');
    assert.equal(await run("document.querySelector('#search-songs img').src"), art[0].url);
    await run("document.querySelectorAll('.error-toast').forEach(toast => toast.remove())");
    await capture('search-artwork');

    await run("void window.api.content.playItem({type:'station', id:'fixture-station'})");
    await waitFor(() => prompts.length === 1, 'first listening choice');
    assert.equal(prompts[0].parent, win);
    assert.deepEqual(prompts[0].options.buttons, ['Let me listen', 'Let them listen']);
    assert.equal(calls.filter(c => c.path.endsWith('/playbackResumed')).length, 0);
    prompts[0].resolve({ response: 1 });
    await waitFor(() => run('AppState.playerState.streamBlocked && !AppState.isLoading'), 'declined takeover');
    assert.equal(await run('AppState.playerState.isPlaying'), false);

    await run('window.api.window.toggleMini()');
    assert.equal(win.getBounds().height, 80);
    // Use the actual Play button to verify a declined conflict can be revisited.
    await run("document.getElementById('play-pause-btn').click()");
    await waitFor(() => prompts.length === 2, 'mini player listening choice');
    prompts[1].resolve({ response: 0 });
    await waitFor(() => run("AppState.playerState.trackToken === 'fixture-track-1' && !document.querySelector('audio')?.paused"), 'takeover audio');
    assert.equal(calls.filter(c => c.path.endsWith('/playbackResumed') && c.body.forceActive).length, 1);
    assert.equal(await run("document.getElementById('mini-thumb-up').classList.contains('liked')"), true);
    await capture('mini-saved-thumb');
    assert.equal(await run("getComputedStyle(document.getElementById('mini-thumb-up')).color"), 'rgb(29, 185, 84)');

    await run('window.api.window.toggleMini()');
    await run("renderPage('nowplaying')");
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

    // A later conflict must stop already buffered audio before asking again.
    canStream = false;
    await run('void window.api.player.getMoreTracks()');
    await waitFor(() => prompts.length === 3, 'background stream conflict');
    await waitFor(() => run("document.querySelector('audio').paused"), 'buffered audio stopped');
    prompts[2].resolve({ response: 1 });
    assert.equal(calls.filter(c => c.path.endsWith('/playbackResumed') && c.body.forceActive).length, 1);
    console.log('Native player smoke test passed: both listening choices, mini Play recovery, buffered audio stop, search images, saved REST thumbs, approved pause/resume.');
    console.log('Screenshots: ' + testData);
    clearTimeout(deadline);
    app.quit();
}).catch(error => {
    clearTimeout(deadline);
    console.error(error);
    app.exit(1);
});
