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
        window.testUI = { render: renderPage, update: updatePlayerUI, load: loadMiniplayerSettings, state: AppState };
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
        bar.dispatchEvent(new s.window.MouseEvent('click', { bubbles: true, clientX: x }));
    };
    click(s.node('classic-progress-bar'), 50);
    click(s.node('progress-bar'), 150);
    assert.deepEqual(s.calls.filter(c => c[0] === 'seek'), [['seek', 50], ['seek', 150]]);
});

test('the classic progress row sits between the song details and the play controls', t => {
    const s = setup(t);
    const order = [...s.node('classic-player').children].map(child => child.className.split(' ')[0]);
    assert.deepEqual(order, ['classic-stage', 'classic-progress', 'classic-controls', 'classic-bottom']);
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
