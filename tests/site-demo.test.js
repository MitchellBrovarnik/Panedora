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
    const messages = [];
    w.postMessage = (data, origin) => messages.push({ data, origin });
    let time = 1000, forbidden = 0, draws = 0;
    Object.defineProperty(w.performance, 'now', { value: () => time });
    const frames = new Map(); let id = 0;
    w.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
    w.cancelAnimationFrame = value => frames.delete(value);
    w.matchMedia = () => ({ matches: reduced, addEventListener() {} });
    w.ResizeObserver = class { observe() {} };
    w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    w.HTMLDialogElement.prototype.close = function () { this.open = false; };
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
    return { w, document: w.document, messages, app: w.demoTest.AppState, get state() { return w.demoTest.AppState.playerState; }, api: w.demoTest,
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
    assert.equal(s.state.track, 'Last Train', 'The selected song plays, rather than the station’s first song');
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

test('the demo publishes its applied accent for every theme, including Adaptive and Reset', async t => {
    const s = await setup(t), d = s.document;
    const themeMessages = () => s.messages.filter(message => message.data.type === 'panedora-demo-theme');
    const accent = () => s.w.getComputedStyle(d.documentElement).getPropertyValue('--accent').trim();
    assert.equal(themeMessages().at(-1).data.accent, '#7c5bf5');
    s.api.renderPage('settings');
    for (const theme of Object.keys(s.api.THEMES)) {
        d.querySelector(`[data-theme="${theme}"]`).click(); await tick();
        assert.equal(themeMessages().at(-1).data.accent, accent());
        assert.equal(themeMessages().at(-1).origin, 'https://panedora.app');
        if (theme === 'adaptive') assert.match(accent(), /^rgb\(/, 'The asynchronously extracted artwork color reaches the parent');
    }
    const count = themeMessages().length;
    d.querySelector('[data-effect="static"]').click(); await tick();
    assert.equal(themeMessages().length, count, 'Unchanged accents do not send repeated updates');
    d.getElementById('demo-reset').click(); await tick();
    assert.equal(themeMessages().at(-1).data.accent, '#7c5bf5');
    assert.equal(s.forbidden(), 0);
});

test('each search result starts that exact sample song once, with mouse or keyboard', async t => {
    const s = await setup(t), d = s.document;
    s.api.renderPage('search');
    const titles = Array.from(d.querySelectorAll('#search-songs .track-row'), row => row.querySelector('.track-title').textContent);
    assert.equal(titles.length, 18);
    for (const [index, title] of titles.entries()) {
        const row = d.querySelectorAll('#search-songs .track-row')[index];
        const generation = s.state.playbackGeneration;
        if (index % 3 === 0) row.click();
        else row.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: index % 3 === 1 ? 'Enter' : ' ', bubbles: true }));
        assert.equal(s.state.track, title);
        assert.equal(s.state.playbackGeneration, generation + 1, 'A selection must not start playback twice');
    }
    assert.equal(s.forbidden(), 0);
});

test('Recently Played shows the newest songs first after skips, station switches and reopening', async t => {
    const s = await setup(t), d = s.document;
    const titles = () => Array.from(d.querySelectorAll('.np-history .history-title'), node => node.textContent);
    s.api.renderPage('nowplaying');
    await s.w.api.content.playItem({ type: 'station', id: 'evening-mix' });
    await s.w.api.player.next();
    await s.w.api.player.next();
    assert.deepEqual(titles(), ['Slow Motion', 'Last Light', 'After Hours']);
    await s.w.api.content.playItem({ type: 'station', id: 'focus' });
    const switched = ['Window Seat', 'Slow Motion', 'Last Light', 'After Hours'];
    assert.deepEqual(titles(), switched, 'Switching stations puts the song just played at the top');
    s.api.renderPage('home');
    s.api.renderPage('nowplaying');
    assert.deepEqual(titles(), switched, 'Reopening the player keeps the same order');

    for (const id of ['focus-1', 'focus-2', 'coastline-0', 'coastline-1', 'coastline-2', 'golden-hour-0']) {
        await s.w.api.content.playItem({ type: 'song', id });
    }
    const recent = ['Daybreak', 'Salt Air', 'Blue Horizon', 'Small Hours', 'Soft Focus', 'Quiet Current', 'Window Seat', 'Slow Motion'];
    assert.deepEqual(titles(), recent, 'Keep the eight most recent past songs when older entries fall out');
    d.querySelector('.np-history .history-thumb-up').click();
    await tick();
    assert.equal(s.state.track, 'Sunday Morning', 'Rating history does not change the current song');
    assert.ok(d.querySelector('.np-history .history-item[data-token="coastline-2"] .history-thumb-up.liked'),
        'The top row still rates the matching recent song');
    assert.deepEqual(titles(), recent, 'Feedback updates keep newest-first order');
    assert.equal(s.forbidden(), 0);
});

test('confirmed station removal immediately updates Library, Home, Search and the sidebar', async t => {
    const s = await setup(t), d = s.document;
    const confirm = async button => {
        button.click();
        assert.equal(d.getElementById('station-remove-dialog').open, true);
        d.getElementById('station-remove-confirm').click(); await tick();
        assert.equal(d.getElementById('station-remove-dialog').open, false);
    };
    s.api.renderPage('library');
    s.app.libraryFilter = 'Radio'; s.api.renderPage('library');
    d.getElementById('main-scroll').scrollTop = 77;
    await confirm(d.querySelector('#library-cards [data-id="evening-mix"] .card-remove-button'));
    assert.equal(d.querySelector('#library-cards [data-id="evening-mix"]'), null);
    assert.equal(d.querySelector('#stations-list [data-id="evening-mix"]'), null);
    assert.equal(d.getElementById('library-filter').value, 'Radio');
    assert.equal(d.querySelector('.library-count').textContent, '5 of 5 stations');
    assert.equal(d.getElementById('main-scroll').scrollTop, 77);
    s.api.renderPage('home');
    assert.equal(d.querySelector('#home-recent [data-id="evening-mix"]'), null);
    await confirm(d.querySelector('#stations-list [data-id="focus"] .delete-btn'));
    assert.equal(d.querySelector('#home-recent [data-id="focus"]'), null);
    assert.equal(d.querySelector('#stations-list [data-id="focus"]'), null);
    s.api.renderPage('search');
    d.getElementById('search-input').value = 'Coastline';
    await s.w.api.content.search('Coastline');
    assert.equal(d.querySelectorAll('#search-stations .card').length, 1);
    await confirm(d.querySelector('#stations-list [data-id="coastline"] .delete-btn'));
    assert.equal(d.querySelectorAll('#search-stations .card').length, 0);
    await s.w.api.content.playShuffle();
    for (let i = 0; i < 6; i++) {
        assert.ok(!['Paper Skies', 'Stillwater', 'Coastline Club'].includes(s.state.artist), 'Shuffle excludes removed stations');
        await s.w.api.player.next();
    }
    d.getElementById('demo-reset').click();
    assert.equal(d.querySelectorAll('#home-recent .card').length, 6);
    assert.equal(d.querySelectorAll('#stations-list .station-item:not(.special-action)').length, 6);
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
    const slider = d.getElementById('volume-slider');
    slider.dispatchEvent(new s.w.Event('pointerdown', { bubbles: true }));
    slider.value = '37';
    slider.dispatchEvent(new s.w.Event('input', { bubbles: true }));
    slider.dispatchEvent(new s.w.Event('change', { bubbles: true }));
    assert.equal(d.getElementById('volume-popover').textContent, '37%');
    assert.equal((await s.w.api.settings.getVolume()).volume, 37);
    d.dispatchEvent(new s.w.Event('pointerup'));
    const first = s.state.trackToken;
    await s.w.api.player.thumbUp();
    assert.equal(s.state.feedback, 'thumbUp');
    await s.w.api.player.next();
    assert.notEqual(s.state.trackToken, first);
    assert.equal(slider.value, '37', 'Changing songs keeps the selected sample volume');
    assert.equal(s.state.history[0].feedback, 'liked');
    s.api.seekToFraction(.5);
    assert.equal(s.state.time, s.state.duration / 2);
    assert.equal(d.getElementById('progress-bar').getAttribute('aria-valuenow'), '50');
    const current = s.state.trackToken;
    await s.w.api.player.thumbDown(first);
    assert.equal(s.state.trackToken, current);
    assert.equal(s.state.history[0].feedback, 'disliked');
    d.getElementById('demo-reset').click();
    assert.equal(slider.value, '65');
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
