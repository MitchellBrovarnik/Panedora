const test = require('node:test');
const assert = require('node:assert/strict');
const { SongNotifications, canShowSongNotification } = require('../song-notifications');

function setup(t, { loadArtwork = async () => 'art', delay = 0 } = {}) {
    let enabled = true, visible = true;
    let state = { trackToken: 'a', playbackGeneration: 1, audioURL: 'https://fixture/audio', isPlaying: true,
        track: 'Song A', artist: 'Artist', album: 'Album', coverArt: 'https://fixture/art' };
    const shown = [];
    let closed = 0;
    const service = new SongNotifications({ enabled: () => enabled, canShow: () => visible,
        getState: () => state, loadArtwork, delay,
        show: options => { shown.push(options); return { close: () => closed++ }; } });
    t.after(() => service.dispose());
    return { service, shown, get closed() { return closed; },
        enable: value => { enabled = value; }, visible: value => { visible = value; },
        next: (trackToken, other = {}) => { state = { ...state, trackToken, track: 'Song ' + trackToken, ...other }; },
        report: (playing = true, overrides = {}) => service.report({ trackToken: state.trackToken,
            playbackGeneration: state.playbackGeneration, playing, ...overrides }),
        flush: async () => { if (service.pending) { clearTimeout(service.pending.timer); await service.deliver(service.pending); } }
    };
}

test('only background playback announces a new song, once, with silent native metadata', async t => {
    const s = setup(t);
    assert.equal(s.report(), true);
    assert.equal(s.report(), false);
    await s.flush();
    assert.deepEqual(s.shown, [{ title: 'Song A', body: 'Artist\nAlbum', silent: true, icon: 'art' }]);
    s.report(false); s.report(); s.service.invalidate(); s.report();
    await s.flush();
    assert.equal(s.shown.length, 1);
    s.next('b'); s.report(); await s.flush();
    assert.equal(s.closed, 1);
    assert.equal(s.shown[1].title, 'Song b');
});

test('disabled and foreground tracks are consumed without announcing after focus or preference changes', async t => {
    const s = setup(t);
    s.enable(false); s.report(); s.enable(true); s.report();
    s.next('b'); s.visible(false); s.report(); s.visible(true); s.report();
    await s.flush(); assert.equal(s.shown.length, 0);
    s.next('c'); s.report(); await s.flush(); assert.equal(s.shown.length, 1);
});

test('buffering before the toast allows one notification when the same track resumes', async t => {
    const s = setup(t);
    assert.equal(s.report(), true);
    s.report(false, { interrupted: true });
    await s.flush();
    assert.equal(s.shown.length, 0);
    assert.equal(s.report(true, { playbackGeneration: 0 }), false);
    assert.equal(s.report(), true);
    assert.equal(s.report(), false);
    await s.flush();
    s.report(false, { interrupted: true });
    assert.equal(s.report(), false);
    assert.deepEqual(s.shown.map(n => n.title), ['Song A']);
});

test('buffering cancels artwork in flight and a pause or invalidation cancels the retry', async t => {
    let release, signal;
    const s = setup(t, { loadArtwork: (_cover, abortSignal) => new Promise(resolve => {
        signal = abortSignal; release = resolve;
    }) });
    s.report();
    const delivering = s.flush();
    s.report(false, { interrupted: true });
    assert.equal(signal.aborted, true);
    release('old');
    await delivering;
    assert.equal(s.shown.length, 0);
    s.report(false); // The listener explicitly paused during buffering.
    assert.equal(s.report(), false);
    s.next('b');
    s.report();
    s.report(false, { interrupted: true });
    s.service.invalidate();
    assert.equal(s.report(), false);
});

test('rapid skips, stale reports, pause and focus changes cannot show outdated notifications', async t => {
    const s = setup(t);
    s.report(); s.next('b'); s.report(); s.next('c');
    assert.equal(s.report(true, { trackToken: 'b' }), false);
    assert.equal(s.report(true, { playbackGeneration: 0 }), false);
    s.report(); await s.flush(); assert.deepEqual(s.shown.map(n => n.title), ['Song c']);
    s.next('d'); s.report(); s.visible(false); await s.flush(); assert.equal(s.shown.length, 1);
    s.visible(true); s.next('e'); s.report(); s.report(false); await s.flush(); assert.equal(s.shown.length, 1);
    s.next('f', { streamBlocked: true }); assert.equal(s.report(), false);
    s.next('g', { streamBlocked: false, stationLoading: true }); assert.equal(s.report(), false);
});

test('late artwork cannot show a stale track; artwork errors fall back to text', async t => {
    let release;
    const s = setup(t, { loadArtwork: () => new Promise(resolve => { release = resolve; }) });
    s.report(); const delivering = s.flush();
    s.next('b'); s.report(); release('old'); await delivering;
    assert.equal(s.shown.length, 0);
    s.service.loadArtwork = async () => { throw new Error('no image'); };
    await s.flush(); assert.equal(s.shown.length, 1); assert.equal(s.shown[0].icon, undefined);
});

test('focused windows and visible always-on-top mini players suppress notifications', () => {
    const win = (focused, visible, minimized, top, destroyed = false) => ({
        isFocused: () => focused, isVisible: () => visible, isMinimized: () => minimized,
        isAlwaysOnTop: () => top, isDestroyed: () => destroyed
    });
    assert.equal(canShowSongNotification(win(true, true, false, false), false), false);
    assert.equal(canShowSongNotification(win(false, true, false, false), false), true);
    assert.equal(canShowSongNotification(win(false, true, false, true), true), false);
    assert.equal(canShowSongNotification(win(false, true, true, true), true), true);
    assert.equal(canShowSongNotification(win(false, false, false, true), true), true);
    assert.equal(canShowSongNotification(win(false, true, false, false), true), true);
    assert.equal(canShowSongNotification(null, false), false);
    assert.equal(canShowSongNotification(win(false, true, false, false, true), false), false);
});
