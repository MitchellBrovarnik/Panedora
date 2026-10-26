const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t, { settings = {} } = {}) {
    const root = path.join(__dirname, '..');
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
        url: 'https://panedora.test/', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    t.after(() => window.close());
    // Each action is its own click, so skip the rapid-click cooldown.
    let now = 1000;
    window.Date.now = () => (now += 10000);
    const calls = [];
    const events = {};
    const player = {
        setVolume: () => {},
        thumbUp: async token => { calls.push(['up', token]); return { success: true }; },
        thumbDown: async token => { calls.push(['down', token]); return { success: true }; },
        undoFeedback: async token => { calls.push(['undo', token]); return { success: true }; },
        next: async () => { calls.push(['next']); }, prev: async () => { calls.push(['prev']); },
        toggle: async () => { calls.push(['toggle']); },
        play: async () => ({ success: true }), pause: async () => ({ success: true }),
        seek: async seconds => { calls.push(['seek', seconds]); return { success: true }; }
    };
    const api = {
        player, content: {},
        window: { toggleMini: async () => { calls.push(['toggleMini']); } },
        discord: { onStatus() {}, getStatus: async () => ({ enabled: false, configured: true, status: 'disabled' }), reportPlayback() {} },
        settings: {
            getVolume: async () => ({ remember: false, volume: 100 }),
            getLegacyMiniplayer: async () => false,
            setLegacyMiniplayer: async enabled => { calls.push(['legacy', enabled]); return enabled; },
            setRememberVolume: async (enabled, volume) => ({ remember: enabled, volume }),
            saveVolume: async () => true,
            ...settings
        }
    };
    for (const name of ['State', 'Collection', 'SearchResults', 'LoginStatus', 'MiniMode', 'Error', 'UpdateNotice']) {
        api['on' + name] = listener => { events[name] = listener; };
    }
    window.api = api;
    window.eval(fs.readFileSync(path.join(root, 'components.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(root, 'renderer.js'), 'utf8') + `
        document.removeEventListener('DOMContentLoaded', init);
        window.testUI = { render: renderPage, update: updatePlayerUI, load: loadMiniplayerSettings, state: AppState,
            preload: url => upcomingArtworkPreloads.get(url) };
        initEventListeners();
        initAPIListeners();
    `);
    window.testUI.state.isLoggedIn = true;
    window.testUI.state.isLoading = false;
    const node = id => window.document.getElementById(id);
    const body = window.document.body;
    return {
        window, ui: window.testUI, calls, events, node, body, api,
        enter: (legacy = true) => events.MiniMode({ isMini: true, legacy }),
        leave: () => events.MiniMode({ isMini: false, legacy: false }),
        classic: () => body.classList.contains('classic-mini')
    };
}

const history = [
    { trackToken: 'old-1', songTitle: 'Old one', artistName: 'Old artist', feedback: null },
    { trackToken: 'old-2', songTitle: 'Old two', artistName: 'Other artist', feedback: 'liked' },
    { trackToken: 'now', songTitle: 'Now song', artistName: 'Now artist' }
];
const playing = { trackToken: 'now', track: 'Now song', artist: 'Now artist', album: 'Now album', isPlaying: true, history };

test('the Use legacy miniplayer switch sits with the other Panedora settings and is off by default', async t => {
    const s = setup(t);
    await s.ui.load();
    s.ui.render('settings');
    const section = s.node('legacy-miniplayer-toggle').closest('.settings-section');
    assert.equal(section.querySelector('.section-title').textContent, 'Panedora Settings');
    assert.equal(section, s.node('remember-volume-toggle').closest('.settings-section'));
    assert.equal(s.node('legacy-miniplayer-toggle').checked, false);
    assert.equal(s.node('legacy-miniplayer-toggle').getAttribute('role'), 'switch');
    assert.match(s.window.document.querySelector('label[for="legacy-miniplayer-toggle"]').textContent, /Use legacy miniplayer/);
});

test('the switch saves its state, shows it when reopened, and recovers from a failed save', async t => {
    const s = setup(t);
    s.ui.render('settings');
    const toggle = s.node('legacy-miniplayer-toggle');
    toggle.click(); await tick();
    assert.deepEqual(s.calls, [['legacy', true]]);
    assert.equal(toggle.checked, true);
    assert.equal(toggle.disabled, false);
    s.ui.render('settings');
    assert.equal(s.node('legacy-miniplayer-toggle').checked, true);
    s.node('legacy-miniplayer-toggle').click(); await tick();
    assert.deepEqual(s.calls.at(-1), ['legacy', false]);
    assert.equal(s.node('legacy-miniplayer-toggle').checked, false);

    for (const failure of [async () => null, async () => { throw new Error('IPC failed'); }]) {
        const f = setup(t, { settings: { setLegacyMiniplayer: failure } });
        f.ui.render('settings');
        f.node('legacy-miniplayer-toggle').click(); await tick();
        assert.equal(f.node('legacy-miniplayer-toggle').checked, false);
        assert.equal(f.node('legacy-miniplayer-toggle').disabled, false);
        assert.match(f.body.textContent, /Could not save the miniplayer setting/);
    }
});

test('a saved legacy setting is loaded at startup and failures leave it off', async t => {
    const on = setup(t, { settings: { getLegacyMiniplayer: async () => true } });
    await on.ui.load();
    on.ui.render('settings');
    assert.equal(on.node('legacy-miniplayer-toggle').checked, true);
    for (const getLegacyMiniplayer of [async () => { throw new Error('IPC failed'); }, async () => null, undefined]) {
        const s = setup(t, { settings: { getLegacyMiniplayer } });
        await s.ui.load();
        s.ui.render('settings');
        assert.equal(s.node('legacy-miniplayer-toggle').checked, false);
    }
});

test('mini mode shows the classic view only when the main process says legacy', t => {
    const s = setup(t);
    s.enter(false);
    assert.equal(s.body.classList.contains('mini-mode'), true);
    assert.equal(s.classic(), false, 'The wide mini player is unchanged');
    s.enter(true);
    assert.equal(s.classic(), true);
    assert.equal(s.body.classList.contains('mini-mode'), true, 'Shares the mini mode background and window handling');
    s.leave();
    assert.equal(s.classic(), false);
    assert.equal(s.body.classList.contains('mini-mode'), false);
    s.events.MiniMode({ isMini: true });
    assert.equal(s.classic(), false, 'A missing flag means the wide mini player');
});

test('the classic view shows artist, track and album and keeps its lines when there is no album', t => {
    const s = setup(t);
    s.ui.update(playing);
    s.enter();
    const text = id => s.node(id).textContent;
    assert.deepEqual([text('classic-artist'), text('classic-track'), text('classic-album')], ['Now artist', 'Now song', 'Now album']);
    assert.equal(s.node('classic-track').title, 'Now song', 'Truncated text is available on hover');
    s.ui.update({ trackToken: 'next', track: 'Next song', artist: 'Next artist', album: undefined, history: [] });
    assert.deepEqual([text('classic-artist'), text('classic-track'), text('classic-album')], ['Next artist', 'Next song', ''],
        'Missing album data clears the line instead of showing the last song\u2019s');
    assert.ok(s.node('classic-album'), 'The empty line stays in the layout');
    s.ui.update({ track: 'Third', artist: 'Third artist', album: 'Third album' });
    assert.equal(text('classic-album'), 'Third album');
});

test('the classic play button, icon and thumbs follow the player state', t => {
    const s = setup(t);
    s.enter();
    s.ui.update({ ...playing, feedback: 'thumbUp' });
    assert.equal(s.node('classic-play').getAttribute('aria-label'), 'Pause');
    assert.match(s.node('classic-play-icon').innerHTML, /M6 19h4V5H6v14/);
    assert.equal(s.node('classic-thumb-up').classList.contains('liked'), true);
    assert.equal(s.node('classic-thumb-down').classList.contains('disliked'), false);
    s.ui.update({ isPlaying: false, feedback: 'thumbDown' });
    assert.equal(s.node('classic-play').getAttribute('aria-label'), 'Play');
    assert.match(s.node('classic-play-icon').innerHTML, /M8 5v14l11-7z/);
    assert.equal(s.node('classic-thumb-up').classList.contains('liked'), false);
    assert.equal(s.node('classic-thumb-down').classList.contains('disliked'), true);
    s.ui.update({ feedback: null });
    assert.equal(s.node('classic-thumb-down').classList.contains('disliked'), false);
});

test('classic controls drive the same actions as the footer controls', async t => {
    const s = setup(t);
    s.ui.update(playing);
    s.enter();
    const footerClicks = [];
    for (const id of ['prev-btn', 'play-pause-btn', 'next-btn']) s.node(id).addEventListener('click', () => footerClicks.push(id));
    s.node('classic-prev').click();
    s.node('classic-play').click();
    s.node('classic-next').click();
    assert.deepEqual(footerClicks, ['prev-btn', 'play-pause-btn', 'next-btn']);
    s.node('classic-thumb-up').click(); await tick();
    s.node('classic-thumb-down').click(); await tick();
    assert.deepEqual(s.calls.filter(c => c[0] === 'up' || c[0] === 'down'), [['up', undefined], ['down', undefined]],
        'Thumbs act on the playing song');
    s.node('classic-expand').click();
    assert.deepEqual(s.calls.at(-1), ['toggleMini']);
});

test('the chevron opens a Recently Played list with the full player\u2019s rows and thumbs', async t => {
    const s = setup(t);
    s.ui.update(playing);
    s.enter();
    const panel = s.node('classic-history');
    const button = s.node('classic-history-btn');
    assert.equal(panel.hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    button.click();
    assert.equal(panel.hidden, false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(s.body.classList.contains('classic-history-open'), true);
    assert.equal(panel.querySelector('.tune-title').textContent, 'RECENTLY PLAYED');
    const rows = [...panel.querySelectorAll('.history-item')];
    assert.deepEqual(rows.map(row => row.dataset.token), ['old-2', 'old-1'], 'Newest first, without the playing song');
    assert.equal(rows[0].classList.contains('history-liked'), true);
    assert.equal(rows[0].querySelector('.history-thumb-up').classList.contains('liked'), true);
    assert.equal(panel.querySelectorAll('.history-art').length, 2);

    // Same behavior as the full player: thumbs, toggling the active thumb, saving by track token.
    rows[1].querySelector('.history-thumb-up').click(); await tick();
    rows[1].querySelector('.history-thumb-down').click(); await tick();
    rows[0].querySelector('.history-thumb-up').click(); await tick();
    assert.deepEqual(s.calls, [['up', 'old-1'], ['down', 'old-1'], ['undo', 'old-2']]);

    // The list refreshes live and keeps its scroll position.
    panel.querySelector('.history-list').scrollTop = 40;
    s.ui.update({ history: history.map(h => h.trackToken === 'old-1' ? { ...h, feedback: 'liked' } : h) });
    assert.equal(panel.querySelector('.history-item[data-token="old-1"] .history-thumb-up').classList.contains('liked'), true);
    assert.equal(panel.querySelector('.history-list').scrollTop, 40);
    s.ui.update({ history: [{ trackToken: 'brand-new', songTitle: 'New', artistName: 'New artist' }, ...history] });
    assert.equal(panel.querySelectorAll('.history-item')[0].dataset.token, 'old-2');
    assert.equal(panel.querySelectorAll('.history-item').length, 3);

    button.click();
    assert.equal(panel.hidden, true);
    assert.equal(panel.innerHTML, '');
    assert.equal(s.body.classList.contains('classic-history-open'), false);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    s.ui.update({ history });
    assert.equal(panel.innerHTML, '', 'A closed list is not rebuilt');
});

test('an empty history shows the same empty message and leaving the classic view closes it', t => {
    const s = setup(t);
    s.ui.update({ trackToken: 'now', track: 'Now song', artist: 'A', history: [] });
    s.enter();
    s.node('classic-history-btn').click();
    assert.match(s.node('classic-history').textContent, /Songs you've played will appear here/);
    s.leave();
    assert.equal(s.node('classic-history').hidden, true);
    assert.equal(s.body.classList.contains('classic-history-open'), false);
    s.enter();
    assert.equal(s.node('classic-history').hidden, true, 'Reopens on the cover, not the list');
});

test('the classic cover loads the current artwork and is left alone when not shown', t => {
    const s = setup(t);
    const sources = ['https://fixture.invalid/cover-large.jpg', 'https://fixture.invalid/cover-small.jpg'];
    const placeholder = s.node('classic-art').getAttribute('src');
    s.ui.update({ ...playing, coverArt: sources[0], coverArtSources: sources });
    assert.equal(s.node('classic-art').getAttribute('src'), placeholder, 'No artwork is fetched for a view that is not showing');
    s.enter();
    assert.equal(s.node('classic-art').getAttribute('src'), sources[0]);
    s.ui.update({ trackToken: 'next', track: 'Next', coverArt: 'https://fixture.invalid/next.jpg',
        coverArtSources: ['https://fixture.invalid/next.jpg'] });
    assert.equal(s.node('classic-art').getAttribute('src'), 'https://fixture.invalid/next.jpg');
});

function finishArtwork(image) {
    Object.defineProperties(image, {
        complete: { value: true, configurable: true },
        naturalWidth: { value: 500, configurable: true }
    });
    image.onload();
}

test('classic playback promotes the ready cover without loading hidden full-player artwork', t => {
    const s = setup(t);
    const large = s.window.document.createElement('img');
    large.id = 'np-large-art';
    s.body.appendChild(large);
    s.enter();
    const url = 'https://fixture.invalid/no-store-next.jpg';
    s.ui.update({ ...playing, coverArt: 'https://fixture.invalid/current.jpg', upcomingArtwork: [url] });
    const prepared = s.ui.preload(url);
    finishArtwork(prepared);
    const writes = [];
    const descriptor = Object.getOwnPropertyDescriptor(s.window.HTMLImageElement.prototype, 'src');
    Object.defineProperty(s.window.HTMLImageElement.prototype, 'src', {
        ...descriptor,
        set(value) { writes.push(value); descriptor.set.call(this, value); }
    });
    s.ui.update({ trackToken: 'next', coverArt: url, upcomingArtwork: [] });
    assert.equal(s.node('classic-art'), prepared, 'The visible player owns the decoded image');
    assert.equal(prepared.complete && prepared.naturalWidth > 0, true);
    assert.equal(writes.includes(url), false, 'No other image is assigned the non-cacheable URL');
    assert.equal(s.node('now-playing-art').getAttribute('src').includes('data:'), true);
    assert.equal(large.getAttribute('src'), null, 'The hidden expanded artwork is not fetched either');
    s.ui.update({ feedback: 'thumbUp' });
    assert.equal(s.node('classic-art'), prepared, 'An ordinary state update preserves the ready image');
});

test('entering and leaving classic mode carries the loaded image and restores footer click behavior', t => {
    const s = setup(t);
    s.ui.update({ ...playing, coverArt: 'https://fixture.invalid/no-store-current.jpg' });
    const ready = s.node('now-playing-art');
    const footerClick = ready.onclick;
    const footerClass = ready.className;
    finishArtwork(ready);
    for (let i = 0; i < 2; i++) {
        s.enter();
        assert.equal(s.node('classic-art'), ready);
        assert.equal(ready.className, 'classic-art');
        assert.equal(ready.getAttribute('width'), '256');
        assert.equal(ready.onclick, null, 'The artwork is only a drag area in classic mode');
        assert.notEqual(s.node('now-playing-art'), ready, 'The hidden footer keeps its own placeholder slot');
        s.leave();
        assert.equal(s.node('now-playing-art'), ready);
        assert.equal(ready.className, footerClass);
        assert.equal(ready.getAttribute('width'), null, 'Classic dimensions do not leak into the footer');
        assert.equal(ready.onclick, footerClick, 'The promoted footer still opens Now Playing');
        assert.equal(s.node('classic-art').className, 'classic-art');
    }
});

test('a late preload replaces the pending classic cover without allowing obsolete callbacks to restore it', t => {
    const s = setup(t);
    s.enter();
    const url = 'https://fixture.invalid/late-cover.jpg';
    s.ui.update({ ...playing, upcomingArtwork: [url] });
    const prepared = s.ui.preload(url);
    s.ui.update({ trackToken: 'next', coverArt: url, upcomingArtwork: [] });
    const pending = s.node('classic-art');
    const oldError = pending.onerror;
    assert.notEqual(pending, prepared, 'The visible image loads directly while the preload is pending');
    finishArtwork(prepared);
    assert.equal(s.node('classic-art'), prepared);
    oldError();
    assert.equal(s.node('classic-art'), prepared);
    assert.equal(prepared.src, url);
});

test('the classic volume slider matches the footer slider, remembers the level and shows the percentage', async t => {
    const saves = [];
    const s = setup(t, { settings: { saveVolume: async value => { saves.push(value); return true; } } });
    s.enter();
    const slider = s.node('classic-volume-slider');
    const popover = s.node('classic-volume-popover');
    const fire = (target, type) => target.dispatchEvent(new s.window.Event(type, { bubbles: true }));
    assert.equal(popover.classList.contains('visible'), false);
    fire(slider, 'pointerdown');
    slider.value = '35'; fire(slider, 'input');
    assert.equal(popover.textContent, '35%');
    assert.equal(popover.classList.contains('visible'), true);
    assert.equal(s.node('volume-slider').value, '35', 'Both sliders show the same level');
    fire(s.window.document.body, 'pointerup');
    s.node('volume-slider').value = '80'; fire(s.node('volume-slider'), 'input');
    assert.equal(slider.value, '80');
});

test('the classic player styles and layout contract is present in the stylesheet', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    const block = selector => {
        const match = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}').exec(css);
        assert.ok(match, 'missing rule ' + selector);
        return match[1];
    };
    assert.match(block('.classic-art'), /width: 256px;[\s\S]*height: 256px;/);
    assert.match(block('body.classic-mini .classic-player'), /--classic-margin: 12px;/);
    for (const line of ['.classic-artist,\n.classic-track,\n.classic-album']) assert.ok(css.includes(line));
    assert.match(css, /\.classic-artist,\n\.classic-track,\n\.classic-album \{[^}]*font-size: 12pt;/);
    assert.match(block('.classic-track'), /font-weight: 700;/);
    assert.match(css, /\.classic-artist,\n\.classic-track,\n\.classic-album \{[^}]*text-align: center;/);
    // The details box uses the full player's glass values and lines up with the cover.
    const info = block('.classic-info');
    assert.match(info, /width: 256px;/);
    assert.match(info, /background-color: var\(--glass\);/);
    assert.match(info, /background-image: linear-gradient\(rgba\(8, 8, 12, 0\.16\), rgba\(8, 8, 12, 0\.16\)\);/, 'A light smoky tint over the glass');
    assert.match(info, /backdrop-filter: blur\(calc\(var\(--blur\) \+ 2px\)\);/, 'The app\u2019s glass blur plus 2px');
    assert.match(info, /border: 1px solid var\(--glass-border\);/);
    // Bottom buttons: thumbs are larger than the centre buttons, which grew slightly from 28px.
    assert.match(block('.classic-thumb'), /width: 38px;[\s\S]*height: 38px;/);
    assert.match(block('.classic-center .classic-btn'), /width: 32px;[\s\S]*height: 32px;/);
    assert.match(css, /\.classic-artist,\n\.classic-album \{\n    font-weight: 400;/);
    assert.match(block('body.classic-mini .player-footer'), /display: none !important;/);
    // The wide mini player hides the volume popover; the classic window is tall enough to show it.
    assert.ok(css.includes('body.mini-mode:not(.classic-mini) .volume-popover {'));
});

test('the classic progress bar mirrors the footer bar and seeks the same way', t => {
    const s = setup(t);
    const read = () => [s.node('classic-progress-fill').style.width, s.node('classic-current-time').textContent,
        s.node('classic-total-time').textContent, s.node('classic-progress-bar').getAttribute('aria-valuenow')];
    s.ui.update({ ...playing, duration: 200, time: 50 });
    assert.deepEqual(read(), ['0%', '0:00', '0:00', '0'], 'Nothing is mirrored while the classic view is not showing');
    s.enter();
    assert.deepEqual(read(), ['25%', '0:50', '3:20', '25'], 'Entering shows the current position');
    s.ui.update({ duration: 200, time: 100 });
    assert.deepEqual(read(), ['50%', '1:40', '3:20', '50'], 'Updates follow the footer bar');
    // Starting a new song resets both bars together.
    s.node('progress-fill').style.width = '0%';
    s.node('current-time').textContent = '0:00';
    s.window.eval('syncClassicProgress()');
    assert.deepEqual(read().slice(0, 2), ['0%', '0:00']);

    // Same bar styling hooks as the full player.
    for (const [classic, footer] of [['classic-progress-bar', 'progress-bar'], ['classic-progress-fill', 'progress-fill']]) {
        assert.equal(s.node(classic).className, s.node(footer).className);
    }
    assert.equal(s.node('classic-current-time').className, 'progress-time');
    assert.equal(s.node('classic-progress-bar').getAttribute('role'), 'progressbar');

    // Clicking the bar seeks proportionally, exactly like the footer bar.
    s.ui.update({ duration: 200, time: 0 });
    const click = (bar, x) => {
        bar.getBoundingClientRect = () => ({ left: 0, width: 200, right: 200, top: 0, bottom: 3, height: 3 });
        for (const type of ['pointerdown', 'pointerup']) {
            bar.dispatchEvent(new s.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x }));
        }
    };
    click(s.node('classic-progress-bar'), 50);
    click(s.node('progress-bar'), 150);
    assert.deepEqual(s.calls.filter(c => c[0] === 'seek'), [['seek', 50], ['seek', 150]]);
});

test('the classic progress row sits between the song details and the play controls', t => {
    const s = setup(t);
    const order = [...s.node('classic-player').children].map(child => child.className.split(' ')[0]);
    assert.deepEqual(order, ['classic-drag', 'classic-stage', 'classic-progress', 'classic-controls', 'classic-bottom']);
    const stage = s.node('classic-player').querySelector('.classic-stage');
    assert.equal(stage.querySelector('.classic-info').previousElementSibling.id, 'classic-art');
});

test('the classic play controls use the full player\u2019s theme-aware styles', t => {
    const s = setup(t);
    assert.equal(s.node('classic-play').className, 'play-pause-btn');
    assert.equal(s.node('classic-prev').className, 'control-btn');
    assert.equal(s.node('classic-next').className, 'control-btn');
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    // The full player's rules supply the accent gradient and glow...
    assert.match(css, /\.play-pause-btn \{[^}]*background: var\(--accent-grad\);[^}]*box-shadow: 0 2px 18px var\(--accent-glow\);/);
    // ...and the wide mini player's smaller sizes are undone for the classic view.
    for (const rule of ['body.mini-mode .classic-controls .play-pause-btn {\n    width: 40px;\n    height: 40px;',
        'body.mini-mode .classic-controls .control-btn {\n    width: 32px;\n    height: 32px;']) assert.ok(css.includes(rule), rule);
    assert.equal(/\.classic-play[\s,{:.]/.test(css), false, 'The old white play button style is gone');
    assert.match(css, /\.classic-progress \.progress-time \{[^}]*color: rgba\(255, 255, 255, 0\.78\);/, 'Times are easier to read');
    assert.match(css, /\.classic-progress \{[^}]*height: 16px;/);
});

test('the chevron is now a History button with a backwards-arrow clock and a lit state while open', t => {
    const s = setup(t);
    s.ui.update(playing);
    s.enter();
    const button = s.node('classic-history-btn');
    assert.equal(button.title, 'History');
    assert.equal(button.querySelector('.classic-chevron'), null, 'The chevron is gone');
    const icon = button.querySelector('svg.classic-history-icon');
    assert.ok(icon);
    // Rim arc, arrow head, clock hands and the two small gap dots.
    assert.equal(icon.querySelectorAll('path').length, 4);
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(button.getAttribute('aria-label'), 'Show song history');
    button.click();
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(button.getAttribute('aria-label'), 'Hide song history');
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    assert.match(css, /#classic-history-btn\[aria-expanded="true"\] \{[^}]*color: var\(--accent\);/);
    assert.equal(css.includes('.classic-chevron'), false);
});

test('the mini-player icon is drawn centred in its box like the other bottom-row icons', t => {
    const s = setup(t);
    const rects = [...s.node('classic-expand').querySelectorAll('rect')].map(rect => ({
        y: +rect.getAttribute('y'), h: +rect.getAttribute('height') }));
    const top = Math.min(...rects.map(r => r.y));
    const bottom = Math.max(...rects.map(r => r.y + r.h));
    assert.equal((top + bottom) / 2, 12, 'The drawing is centred vertically in the 24-unit box');
});

const nextFrame = s => new Promise(resolve => s.window.requestAnimationFrame(() => resolve()));

// jsdom has no layout, so give a line a measured width and its box an available width.
function measure(s, id, { text, box = 234 }) {
    const line = s.node(id);
    const inner = line.querySelector('.classic-line-text');
    Object.defineProperty(inner, 'scrollWidth', { value: text, configurable: true });
    Object.defineProperty(line, 'clientWidth', { value: box, configurable: true });
    line.style.paddingLeft = line.style.paddingRight = '0px';
    return inner;
}

test('a line that runs off the right side scrolls, and short lines stay still and centred', async t => {
    const s = setup(t);
    s.ui.update(playing);
    s.enter();
    await nextFrame(s);
    const track = measure(s, 'classic-track', { text: 320 });
    const artist = measure(s, 'classic-artist', { text: 120 });
    measure(s, 'classic-album', { text: 90 });
    s.ui.update({ track: 'A very long song title that cannot possibly fit', artist: 'Short', album: 'Short album' });
    await nextFrame(s);
    assert.equal(track.classList.contains('marquee'), true, 'The long title scrolls');
    assert.equal(track.style.getPropertyValue('--marquee-offset'), '-102px', 'Scrolls to its end (overflow plus a little room)');
    assert.equal(track.style.getPropertyValue('--marquee-duration'), `${(320 - 234) / 15}s`);
    assert.equal(artist.classList.contains('marquee'), false, 'Lines that fit do not scroll');
    assert.equal(s.node('classic-album').querySelector('.classic-line-text').classList.contains('marquee'), false);
    assert.equal(s.node('classic-track').title, 'A very long song title that cannot possibly fit', 'Full text on hover');

    // Unrelated updates (play/pause, thumbs) must not restart a line that is mid-scroll.
    Object.defineProperty(track, 'scrollWidth', { value: 100, configurable: true });
    s.ui.update({ isPlaying: false });
    s.ui.update({ feedback: 'thumbUp' });
    await nextFrame(s);
    assert.equal(track.classList.contains('marquee'), true, 'Not re-measured while the text is unchanged');
    // A new, shorter title is measured and stops scrolling.
    s.ui.update({ track: 'Short title' });
    await nextFrame(s);
    assert.equal(track.classList.contains('marquee'), false);
    assert.equal(track.style.getPropertyValue('--marquee-offset'), '');
});

test('lines that ran off the edge are measured again when the classic view is opened later', async t => {
    const s = setup(t);
    s.ui.update(playing);
    s.ui.update({ track: 'Updated while the classic view is closed' });
    s.enter();
    await nextFrame(s);
    const inner = measure(s, 'classic-track', { text: 400 });
    assert.equal(inner.classList.contains('marquee'), false, 'Nothing is measured while the view is hidden');
    s.ui.update({ track: 'Another long title to scroll' });
    await nextFrame(s);
    assert.equal(inner.classList.contains('marquee'), true);
});

test('only the album art and the margin around it can drag the window', t => {
    const s = setup(t);
    const player = s.node('classic-player');
    const band = player.firstElementChild;
    assert.equal(band.className, 'classic-drag');
    assert.equal(band.getAttribute('aria-hidden'), 'true');
    assert.equal(s.node('classic-art').closest('.classic-drag'), null, 'The band is a sibling behind the content, not a wrapper');
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    const classic = css.slice(css.indexOf('Classic mini player ("Use legacy miniplayer")'), css.indexOf('/* Mini Thumbs'));
    const rule = selector => new RegExp('(?:^|\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}').exec(classic)?.[1];
    assert.match(rule('.classic-drag'), /position: absolute;[\s\S]*top: 0;[\s\S]*left: 0;[\s\S]*right: 0;/, 'Spans the full window width');
    assert.match(rule('.classic-drag'), /height: calc\(var\(--classic-margin\) \* 2 \+ 256px\);/, 'Margin + 256px cover + margin: ends where the details box begins');
    assert.match(rule('.classic-drag'), /-webkit-app-region: drag;/);
    assert.equal(/app-region/.test(rule('body.classic-mini .classic-player')), false, 'The whole player is no longer a drag region');
    assert.equal((classic.match(/-webkit-app-region: drag/g) || []).length, 1, 'The band is the only draggable part');
    // Interactive parts, including the history list that can cover the art, are never draggable.
    assert.match(classic, /\.classic-btn,\n\.classic-volume-slider,\n\.classic-history,\n\.classic-controls button,\n\.classic-progress \{\n    -webkit-app-region: no-drag;/);
    assert.match(rule('.classic-art'), /-webkit-user-drag: none;/);
});

test('the classic volume knob can be grabbed anywhere on it, and its popover follows the larger knob', t => {
    const s = setup(t);
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    const rule = selector => new RegExp('(?:^|\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}').exec(css)?.[1];
    const slider = rule('.classic-volume-slider');
    const knob = rule('.classic-volume-slider::-webkit-slider-thumb');
    const height = +/height: (\d+)px;/.exec(slider)[1];
    const knobSize = +/height: (\d+)px;/.exec(knob)[1];
    assert.ok(height >= knobSize + 4, `The slider box (${height}px) must be taller than the knob (${knobSize}px) or part of the knob is not clickable`);
    assert.match(slider, /width: 64px;/);
    assert.match(slider, /background: transparent;/, 'The thin track is drawn separately');
    assert.match(rule('.classic-volume-slider::-webkit-slider-runnable-track'), /height: 4px;/);
    assert.match(knob, /width: 14px;[\s\S]*height: 14px;/);
    assert.equal(+/margin-top: (-?\d+)px;/.exec(knob)[1], (4 - knobSize) / 2, 'Knob centred on the 4px track');
    // 18px icon + 4px gap + 64px slider still fits in the 94px column beside the centre buttons.
    assert.ok(18 + 4 + 64 <= (256 - 68) / 2);

    // The popover is placed by the knob size: 14px here, 11px for the footer slider.
    s.enter();
    const classic = s.node('classic-volume-slider');
    Object.defineProperty(classic, 'offsetWidth', { value: 64 });
    Object.defineProperty(classic, 'offsetLeft', { value: 22 });
    const fire = (target, type) => target.dispatchEvent(new s.window.Event(type, { bubbles: true }));
    fire(classic, 'pointerdown');
    classic.value = '100'; fire(classic, 'input');
    assert.equal(s.node('classic-volume-popover').style.left, `${22 + 14 / 2 + 50}px`, 'Centred on the 14px knob at 100%');
    classic.value = '0'; fire(classic, 'input');
    assert.equal(s.node('classic-volume-popover').style.left, `${22 + 14 / 2}px`);
    fire(s.window.document.body, 'pointerup');
    const footer = s.node('volume-slider');
    Object.defineProperty(footer, 'offsetWidth', { value: 90 });
    Object.defineProperty(footer, 'offsetLeft', { value: 10 });
    fire(footer, 'pointerdown');
    footer.value = '100'; fire(footer, 'input');
    assert.equal(s.node('volume-popover').style.left, `${10 + 11 / 2 + 79}px`, 'The footer slider keeps its 11px knob');
});

test('a scrolling line rests 7 seconds, then scrolls again, and stops when its text no longer overflows', async t => {
    const s = setup(t);
    s.ui.update(playing);
    s.enter();
    await nextFrame(s);
    const timers = [];
    s.window.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; };
    s.window.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].live = false; };
    const track = measure(s, 'classic-track', { text: 320 });
    s.ui.update({ track: 'A very long song title that cannot possibly fit' });
    await nextFrame(s);
    const ended = (name = 'marquee-scroll') => {
        const event = new s.window.Event('animationend', { bubbles: true });
        Object.defineProperty(event, 'animationName', { value: name });
        track.dispatchEvent(event);
    };
    const pending = () => timers.filter(timer => timer.live);
    const fire = timer => { timer.live = false; timer.fn(); }; // a timer runs once
    assert.equal(track.classList.contains('marquee'), true, 'First run starts (after its own short delay in CSS)');
    assert.equal(track.classList.contains('marquee-repeat'), false);

    ended('some-other-animation');
    assert.equal(track.classList.contains('marquee'), true, 'Other animations do not count');
    ended();
    assert.equal(track.classList.contains('marquee'), false, 'Back at the start, resting');
    assert.deepEqual(pending().map(timer => timer.ms), [7000], 'Rests for 7 seconds');
    fire(pending()[0]);
    assert.equal(track.classList.contains('marquee'), true, 'Scrolls again');
    assert.equal(track.classList.contains('marquee-repeat'), true, 'without repeating the start delay');
    ended();
    assert.equal(pending().length, 1, 'and rests again');

    // A different title measured during the rest cancels the pending repeat.
    Object.defineProperty(track, 'scrollWidth', { value: 100, configurable: true });
    s.ui.update({ track: 'Short' });
    await nextFrame(s);
    assert.equal(pending().length, 0, 'The old wait is cancelled');
    assert.equal(track.classList.contains('marquee'), false);
    assert.equal(track.classList.contains('marquee-repeat'), false);
    ended();
    for (const timer of pending()) fire(timer);
    assert.equal(track.classList.contains('marquee'), false, 'A line that fits never restarts');

    const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    assert.match(css, /\.classic-line-text\.marquee \{\n    animation: marquee-scroll var\(--marquee-duration, 8s\) linear 1;/, 'One scroll per run');
    assert.match(css, /\.classic-line-text\.marquee\.marquee-repeat \{\n    animation-delay: 0s;/);
    assert.match(css, /body\.mini-mode \.now-playing-title\.marquee \{\n    animation: marquee-scroll var\(--marquee-duration, 8s\) linear infinite;/,
        'The wide mini player\u2019s marquee is unchanged');
});
