const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, reduced = false) {
    const dom = new JSDOM(read('docs/demo/index.html'), { url: 'https://panedora.app/demo/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    t.after(() => w.close());
    let time = 1000, forbidden = 0, draws = 0;
    Object.defineProperty(w.performance, 'now', { value: () => time });
    const frames = new Map(); let id = 0;
    w.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
    w.cancelAnimationFrame = value => frames.delete(value);
    w.matchMedia = () => ({ matches: reduced, addEventListener() {} });
    w.ResizeObserver = class { observe() {} };
    w.Element.prototype.getAnimations = () => [];
    const forbiddenCall = () => { forbidden++; throw new Error('The demo must stay local and silent'); };
    w.fetch = forbiddenCall; w.XMLHttpRequest = forbiddenCall; w.WebSocket = forbiddenCall; w.AudioContext = forbiddenCall; w.Audio = forbiddenCall;
    const gradient = { addColorStop() {} };
    const pixels = new Uint8ClampedArray(10000);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([75, 100, 190, 255], i);
    const context = new Proxy({
        getImageData: () => ({ data: pixels }),
        createLinearGradient: () => gradient, createRadialGradient: () => gradient,
        fillRect: () => { draws++; }, stroke: () => { draws++; }, fill: () => { draws++; }
    }, { get: (target, name) => target[name] || (() => {}) });
    w.HTMLCanvasElement.prototype.getContext = () => context;
    Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { get: () => 480 });
    Object.defineProperty(w.HTMLImageElement.prototype, 'complete', { get: () => true });
    const src = Object.getOwnPropertyDescriptor(w.HTMLImageElement.prototype, 'src');
    Object.defineProperty(w.HTMLImageElement.prototype, 'src', { get: src.get, set(value) {
        src.set.call(this, value); queueMicrotask(() => this.onload?.(new w.Event('load')));
    } });
    // Browser classic scripts share lexical bindings. Evaluate together here too.
    w.eval(read('docs/demo/app.js') + '\n' + read('docs/demo/demo.js') + '\nwindow.demoTest = { AppState, THEMES, BG_EFFECTS, renderPage, applyBgEffect, seekToFraction };');
    await tick();
    return { w, document: w.document, app: w.demoTest.AppState, get state() { return w.demoTest.AppState.playerState; }, api: w.demoTest,
        advance: n => { time += n; }, forbidden: () => forbidden, draws: () => draws };
}

test('the website demo snapshot matches the current desktop interface', () => {
    const result = spawnSync(process.execPath, ['scripts/build-site-demo.js', '--check'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const html = read('docs/demo/index.html');
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /media-src 'none'/);
    assert.doesNotMatch(html, /titlebar-minimize/);
});

test('sample stations, library filtering, search and reset work without services', async t => {
    const s = await setup(t), d = s.document;
    assert.equal(d.querySelectorAll('#home-recent .card').length, 6);
    d.querySelector('#home-recent [data-id="focus"]').click();
    assert.equal(s.state.stationName, 'Focus Radio');
    assert.equal(s.state.track, 'Quiet Current');
    s.api.renderPage('library');
    d.getElementById('library-filter').value = 'Night';
    d.getElementById('library-filter').dispatchEvent(new s.w.Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(d.querySelectorAll('#library-cards .card').length, 1);
    s.api.renderPage('search');
    await s.w.api.content.search('Last Train');
    assert.equal(d.querySelectorAll('#search-songs .track-row').length, 1);
    d.querySelector('#search-songs .track-row').click();
    assert.equal(s.state.stationName, 'Night Drive Radio', 'A song result starts its related sample station');
    await s.w.api.content.search('no-such-song');
    assert.match(d.getElementById('page-content').textContent, /No sample matches/);
    s.api.renderPage('settings');
    await s.w.api.content.search('After Hours');
    assert.ok(d.querySelector('[data-theme]'), 'A late search result cannot replace the page after navigation');
    d.getElementById('demo-reset').click();
    assert.equal(s.app.currentPage, 'home');
    assert.equal(s.app.stations.length, 6);
    assert.equal(s.app.currentTheme, 'midnight');
    assert.equal(s.app.currentEffect, 'waves');
    assert.equal(s.forbidden(), 0);
});

test('every app theme and effect is available, with silent simulated reactive movement', async t => {
    const s = await setup(t), d = s.document;
    s.api.renderPage('settings');
    assert.equal(d.querySelectorAll('[data-theme]').length, 9);
    assert.equal(d.querySelectorAll('[data-effect]').length, 10);
    for (const theme of Object.keys(s.api.THEMES)) {
        d.querySelector(`[data-theme="${theme}"]`).click(); await tick();
        assert.equal(s.app.currentTheme, theme);
        assert.equal(d.querySelector(`[data-theme="${theme}"]`).getAttribute('aria-pressed'), 'true');
        assert.equal(d.querySelector('#legacy-miniplayer-toggle').closest('section').hidden, true);
    }
    for (const effect of Object.keys(s.api.BG_EFFECTS)) {
        d.querySelector(`[data-effect="${effect}"]`).click();
        assert.equal(s.app.currentEffect, effect);
        if (effect.startsWith('reactive-')) {
            assert.equal(s.w.visualizer.isVisualizing, true);
            assert.ok(s.w.visualizer.animationId);
            assert.equal(s.w.visualizer.style, effect.replace('reactive-', ''));
        } else assert.equal(s.w.visualizer.isVisualizing, false);
    }
    const a = new Float32Array(32), b = new Float32Array(32);
    s.w.visualizer.analyser.getFloatFrequencyData(a); s.advance(1000); s.w.visualizer.analyser.getFloatFrequencyData(b);
    assert.notDeepEqual(a, b, 'The synthetic signal changes with time');
    assert.ok([...b].every(Number.isFinite));
    assert.ok(s.draws() > 0, 'The actual visualizer drawing routines ran');
    assert.equal(d.querySelector('audio'), null);
    assert.equal(s.forbidden(), 0);
});

test('playback, seeking and thumbs change only the sample session', async t => {
    const s = await setup(t), d = s.document;
    d.getElementById('play-pause-btn').click();
    assert.equal(s.state.isPlaying, false);
    d.getElementById('play-pause-btn').click();
    assert.equal(s.state.isPlaying, true);
    const first = s.state.trackToken;
    await s.w.api.player.thumbUp();
    assert.equal(s.state.feedback, 'thumbUp');
    await s.w.api.player.next();
    assert.notEqual(s.state.trackToken, first);
    assert.equal(s.state.history[0].feedback, 'liked');
    s.api.seekToFraction(.5);
    assert.equal(s.state.time, s.state.duration / 2);
    assert.equal(d.getElementById('progress-bar').getAttribute('aria-valuenow'), '50');
    const current = s.state.trackToken;
    await s.w.api.player.thumbDown(first);
    assert.equal(s.state.trackToken, current);
    assert.equal(s.state.history[0].feedback, 'disliked');
    d.getElementById('demo-reset').click();
    assert.equal(s.state.feedback, null);
    assert.deepEqual(Array.from(s.state.history), []);
    assert.equal(s.forbidden(), 0);
});

test('motion controls, hidden embeds and reduced-motion preferences stop animation loops', async t => {
    const s = await setup(t), d = s.document;
    s.api.applyBgEffect('reactive-bars');
    assert.equal(s.w.visualizer.isVisualizing, true);
    d.getElementById('demo-motion').click();
    assert.equal(s.w.visualizer.isVisualizing, false);
    assert.equal(s.w.visualizer.animationId, null);
    d.getElementById('demo-motion').click();
    assert.equal(s.w.visualizer.isVisualizing, true);
    const send = (visible, source = s.w, origin = 'https://panedora.app') => s.w.dispatchEvent(new s.w.MessageEvent('message', {
        source, origin, data: { type: 'panedora-demo-visibility', visible }
    }));
    send(false, null);
    assert.equal(s.w.visualizer.isVisualizing, true, 'Other windows cannot control the preview');
    send(false);
    assert.equal(s.w.visualizer.isVisualizing, false);
    send(true);
    assert.equal(s.w.visualizer.isVisualizing, true);
    const r = await setup(t, true);
    r.api.applyBgEffect('reactive-circle');
    assert.equal(r.w.visualizer.isVisualizing, false);
    assert.equal(r.document.getElementById('demo-motion').textContent, 'Play motion');
    r.document.getElementById('demo-motion').click();
    assert.equal(r.w.visualizer.isVisualizing, true, 'Visitors can explicitly opt in');
});
