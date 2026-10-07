const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const tick = () => new Promise(resolve => setImmediate(resolve));
function modes(currentModeId = 0, extra = {}) {
    return { status: 'ready', available: true, currentModeId, changing: false, modes: [
        { id: 0, name: 'My Station', description: 'Your station.', available: true },
        { id: 1091989, name: 'Energy Boost', description: 'More energy <without markup>.', available: true },
        { id: 5, name: 'Artist Only', available: false, premiumOnly: true },
        { id: 987654, name: 'Curated <Mix>', available: true }
    ], ...extra };
}

function setup(t) {
    const root = path.join(__dirname, '..');
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
        url: 'https://panedora.test/', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    const images = [];
    window.Image = class { constructor() { images.push(this); } };
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    const calls = [];
    const player = {
        getStationModes: async stationId => {
            calls.push(['get', stationId]);
            window.testUI.update({ stationModes: modes() });
            return { success: true };
        },
        resolveStreamConflict: async (id, takeOver) => {
            calls.push(['takeover', id, takeOver]);
            window.testUI.update({ streamPrompt: null });
            return { success: true };
        },
        setStationMode: async (stationId, modeId) => {
            calls.push(['set', stationId, modeId]);
            window.testUI.update({ stationModes: modes(modeId) });
            return { success: true };
        }
    };
    const events = {};
    window.api = { player, window: {}, content: {} };
    window.api.discord = {
        onStatus: listener => { events.DiscordStatus = listener; },
        getStatus: async () => ({ enabled: false, configured: true, status: 'disabled' }),
        setEnabled: async enabled => ({ enabled, configured: true, status: enabled ? 'idle' : 'disabled' }),
        reportPlayback() {}
    };
    for (const name of ['State', 'Collection', 'SearchResults', 'LoginStatus', 'MiniMode', 'Error', 'UpdateNotice']) {
        window.api['on' + name] = listener => { events[name] = listener; };
    }
    window.eval(fs.readFileSync(path.join(root, 'components.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(root, 'renderer.js'), 'utf8') + `
        document.removeEventListener('DOMContentLoaded', init);
        window.testUI = { state: AppState, update: updatePlayerUI, render: renderPage, renderStations: renderStationsList,
            checkUpdates: checkForUpdateNotice, openRemoval: openStationRemoval, closeRemoval: closeStationRemoval };
        initEventListeners();
        initAPIListeners();
    `);
    const ui = window.testUI;
    ui.state.isLoggedIn = true;
    ui.state.isLoading = false;
    ui.update({
        playbackGeneration: 1,
        stationId: 'station-1', stationName: 'Fixture Radio', track: 'Current Song',
        trackToken: 'current', feedback: 'thumbUp', isPlaying: true,
        stationModes: { status: 'idle' }
    });
    ui.render('home');
    t.after(() => window.close());
    const node = id => window.document.getElementById(id);
    const open = () => node('now-playing-art').click();
    const select = value => {
        node('np-mode-select').click();
        node('np-mode-option-' + value).click();
    };
    return { window, ui, player, calls, node, open, select, events, images };
}

test('Discord setting is opt-in, accessible, reflects live status, and handles unavailable builds', async t => {
    const s = setup(t);
    await tick(); s.ui.render('settings');
    const toggle = s.node('discord-sharing-toggle');
    assert.equal(toggle.checked, false);
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.getAttribute('role'), 'switch');
    toggle.click(); await tick();
    assert.equal(toggle.checked, true);
    assert.match(s.node('discord-sharing-status').textContent, /Ready/);
    s.events.DiscordStatus({ enabled: true, configured: true, status: 'connected' });
    assert.match(s.node('discord-sharing-status').textContent, /Connected/);
    assert.equal(s.node('discord-sharing-toggle'), toggle, 'Status updates preserve the focused control');
    s.events.DiscordStatus({ enabled: false, configured: false, status: 'unconfigured' });
    assert.equal(toggle.disabled, true);
    assert.match(s.node('discord-sharing-status').textContent, /not configured/);
});

test('Discord setting recovers from a failed save without changing the saved choice', async t => {
    const s = setup(t); await tick(); s.ui.render('settings');
    s.window.api.discord.setEnabled = async () => { throw new Error('IPC failed'); };
    s.node('discord-sharing-toggle').click(); await tick();
    assert.equal(s.node('discord-sharing-toggle').checked, false);
    assert.equal(s.node('discord-sharing-toggle').disabled, false);
    assert.match(s.window.document.querySelector('.error-toast').textContent, /Could not save Discord/);
});

test('player artwork loads directly without a probe or placeholder between valid covers', t => {
    const s = setup(t);
    s.ui.update({ coverArt: 'https://fixture.invalid/large.jpg', coverArtSources: ['https://fixture.invalid/small.jpg'] });
    s.open();
    for (const id of ['now-playing-art', 'np-large-art']) assert.equal(s.node(id).src, 'https://fixture.invalid/large.jpg');
    assert.equal(s.images.length, 0, 'The visible images load the cover without waiting for invisible probes');
    const changes = [];
    const observer = new s.window.MutationObserver(() => {});
    for (const id of ['now-playing-art', 'np-large-art']) {
        observer.observe(s.node(id), { attributes: true, attributeFilter: ['src'], attributeOldValue: true });
    }
    s.ui.update({ trackToken: 'next', coverArt: 'https://fixture.invalid/next.jpg', coverArtSources: [] });
    changes.push(...observer.takeRecords());
    assert.equal(changes.length, 2, 'Only one source assignment per visible player');
    assert.ok(changes.every(change => change.oldValue === 'https://fixture.invalid/large.jpg'));
    for (const id of ['now-playing-art', 'np-large-art']) assert.equal(s.node(id).src, 'https://fixture.invalid/next.jpg');
    s.ui.update({ isPlaying: false, feedback: 'thumbUp' });
    s.ui.update({ trackToken: 'same-album', playbackGeneration: 2, coverArt: 'https://fixture.invalid/next.jpg', coverArtSources: [] });
    assert.equal(observer.takeRecords().length, 0, 'Partial updates and another song with the same cover preserve the image');
    s.ui.update({ trackToken: 'no-art', coverArt: null, coverArtSources: [] });
    for (const id of ['now-playing-art', 'np-large-art']) assert.match(s.node(id).src, /^data:image\/svg/);
    observer.disconnect();
});

test('failed covers try supplied sizes and late failures cannot replace a newer cover', t => {
    const s = setup(t);
    s.ui.update({ coverArt: 'https://fixture.invalid/large.jpg', coverArtSources: ['https://fixture.invalid/small.jpg'] });
    const image = s.node('now-playing-art');
    Object.defineProperty(image, 'complete', { configurable: true, value: true });
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 0 });
    const failedLarge = image.onerror;
    failedLarge();
    assert.equal(image.src, 'https://fixture.invalid/small.jpg');
    const failedSmall = image.onerror;
    failedLarge();
    assert.equal(image.src, 'https://fixture.invalid/small.jpg', 'An old attempt cannot fail the next size');
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 500 });
    s.open();
    assert.equal(s.node('np-large-art').src, image.src, 'Expanding the player reuses the working cover');
    s.ui.update({ trackToken: 'next', coverArt: 'https://fixture.invalid/next.jpg', coverArtSources: [] });
    failedSmall();
    for (const id of ['now-playing-art', 'np-large-art']) assert.equal(s.node(id).src, 'https://fixture.invalid/next.jpg');
    image.onerror();
    assert.equal(image.src, 'https://fixture.invalid/next.jpg', 'A delayed error cannot replace a successfully loaded image');
});

test('a transient artwork failure retries once and repeated failures do not loop', t => {
    const s = setup(t);
    const retries = [];
    const setTimer = s.window.setTimeout.bind(s.window);
    s.window.setTimeout = (callback, delay) => {
        if (delay === 1000) { retries.push(callback); return 12345; }
        return setTimer(callback, delay);
    };
    s.ui.update({ coverArt: 'https://fixture.invalid/transient.jpg' });
    const image = s.node('now-playing-art');
    Object.defineProperty(image, 'complete', { configurable: true, value: true });
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 0 });
    image.onerror();
    assert.equal(retries.length, 1);
    assert.match(image.src, /^data:image\/svg/);
    retries[0]();
    assert.equal(image.src, 'https://fixture.invalid/transient.jpg');
    image.onerror();
    s.ui.update({ isPlaying: false });
    assert.equal(retries.length, 1);
    assert.match(image.src, /^data:image\/svg/);
    s.ui.update({ trackToken: 'same-cover', coverArt: 'https://fixture.invalid/transient.jpg', coverArtSources: [] });
    assert.equal(image.src, 'https://fixture.invalid/transient.jpg', 'A new song can retry the same cover after a complete failure');
    image.onerror();
    assert.equal(retries.length, 2);
    s.ui.update({ trackToken: 'new-song', coverArt: 'https://fixture.invalid/new.jpg', coverArtSources: [] });
    retries.forEach(callback => callback());
    assert.equal(image.src, 'https://fixture.invalid/new.jpg', 'An old retry cannot restore a skipped cover');
});

test('update banner escapes versions and leaves focus, navigation and playback alone', async t => {
    const s = setup(t);
    const responses = [];
    s.window.api.updates = {
        check: async () => ({ version: '<b>1.2.0</b>', currentVersion: '1.1.3' }),
        respond: async (...args) => { responses.push(args); return { success: true }; }
    };
    const previous = s.node('play-pause-btn');
    previous.focus();
    assert.equal(s.node('main-header').hidden, true, 'Home has no empty update row');
    await s.ui.checkUpdates();
    assert.equal(s.node('update-banner').hidden, false);
    assert.equal(s.node('main-header').hidden, false);
    assert.equal(s.node('update-available-version').textContent, '<b>1.2.0</b>');
    assert.equal(s.node('update-available-version').children.length, 0);
    assert.equal(s.window.document.activeElement, previous);
    assert.equal(s.window.document.querySelector('dialog[open]'), null);
    s.ui.render('search');
    s.node('search-input').focus();
    assert.equal(s.window.document.activeElement, s.node('search-input'));
    assert.equal(s.node('update-banner').hidden, false);
    s.ui.render('home');
    previous.focus();
    s.node('update-download').click();
    s.node('update-download').click();
    await tick();
    assert.deepEqual(responses, [['<b>1.2.0</b>', 'download']]);
    assert.equal(s.node('update-banner').hidden, true);
    assert.equal(s.node('main-header').hidden, true, 'Dismissing the pill removes its empty row');
    assert.equal(s.window.document.activeElement, previous);
    assert.equal(s.ui.state.playerState.isPlaying, true);
    assert.deepEqual(s.calls, []);
    s.ui.render('search');
    assert.equal(s.node('main-header').hidden, false, 'Search keeps its input after update dismissal');
    assert.equal(s.node('search-container').style.display, 'block');
    s.ui.render('home');
    assert.equal(s.node('main-header').hidden, true);
});

test('update banner waits for mini mode and higher priority dialogs without taking focus', async t => {
    const s = setup(t);
    s.window.api.updates = { check: async () => ({ version: '1.2.0', currentVersion: '1.1.3' }),
        respond: async () => ({ success: true }) };
    s.events.MiniMode({ isMini: true });
    await s.ui.checkUpdates();
    assert.equal(s.node('update-banner').hidden, true);
    s.events.MiniMode({ isMini: false });
    assert.equal(s.node('update-banner').hidden, false);
    s.ui.update({ streamPrompt: { id: 1, pending: false } });
    assert.equal(s.node('update-banner').hidden, true);
    assert.equal(s.node('stream-conflict-dialog').open, true);
    s.ui.update({ streamPrompt: null });
    assert.equal(s.node('stream-conflict-dialog').open, false);
    assert.equal(s.node('update-banner').hidden, false);
    s.ui.openRemoval({ id: 'station-1', name: 'Fixture Station' });
    assert.equal(s.node('update-banner').hidden, true);
    assert.equal(s.node('station-remove-dialog').open, true);
    s.ui.closeRemoval();
    assert.equal(s.node('station-remove-dialog').open, false);
    assert.equal(s.node('update-banner').hidden, false);
    s.ui.render('search');
    s.events.MiniMode({ isMini: true });
    s.node('search-input').focus();
    s.events.MiniMode({ isMini: false });
    assert.equal(s.window.document.activeElement, s.node('search-input'));
    s.node('update-later').click();
    await tick();
    assert.equal(s.node('update-banner').hidden, true);
    assert.equal(s.ui.state.playerState.isPlaying, true);
});

test('update banner errors are retryable, disable only its buttons and leave Escape alone', async t => {
    const s = setup(t);
    const responses = [];
    let fail = true;
    s.window.api.updates = { check: async () => ({ version: '1.2.0', currentVersion: '1.1.3' }),
        respond: async (...args) => { responses.push(args); if (fail) throw new Error('IPC disconnected'); return { success: true }; } };
    await s.ui.checkUpdates();
    s.node('update-download').click();
    assert.equal(s.node('update-later').disabled, true);
    assert.equal(s.node('play-pause-btn').disabled, false);
    await tick();
    assert.equal(s.node('update-banner').hidden, false);
    assert.equal(s.node('update-download').disabled, false);
    assert.match(s.node('update-error').textContent, /Please try again/);
    fail = false;
    const escape = new s.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    s.window.document.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, false);
    assert.equal(s.node('update-banner').hidden, false);
    assert.equal(responses.length, 1);
    s.node('update-later').click();
    await tick();
    assert.deepEqual(responses, [['1.2.0', 'download'], ['1.2.0', 'later']]);
    assert.equal(s.node('update-banner').hidden, true);
});

test('failed and empty background update checks keep the banner hidden and playback unchanged', async t => {
    const s = setup(t);
    s.window.api.updates = { check: async () => { throw new Error('Offline'); } };
    await s.ui.checkUpdates();
    s.window.api.updates.check = async () => null;
    await s.ui.checkUpdates();
    assert.equal(s.node('update-banner').hidden, true);
    assert.equal(s.ui.state.playerState.isPlaying, true);
    assert.deepEqual(s.calls, []);
});

test('a background update notice preserves an open station mode menu and its focus', async t => {
    const s = setup(t);
    s.open();
    await tick();
    s.node('np-mode-select').click();
    const focusedOption = s.window.document.activeElement;
    assert.equal(s.node('np-mode-menu').hidden, false);
    s.window.api.updates = { check: async () => ({ version: '1.2.0', currentVersion: '1.1.3' }) };
    await s.ui.checkUpdates();
    assert.equal(s.node('update-banner').hidden, false);
    assert.equal(s.node('np-mode-menu').hidden, false);
    assert.equal(s.window.document.activeElement, focusedOption);
    assert.equal(s.ui.state.playerState.isPlaying, true);
});

test('scheduled notices wait in mini mode and behind station dialogs without taking focus', t => {
    const s = setup(t);
    s.node('play-pause-btn').focus();
    const focused = s.window.document.activeElement;
    s.events.MiniMode({ isMini: true });
    s.events.UpdateNotice({ version: '1.2.0', currentVersion: '1.1.3' });
    assert.equal(s.node('update-banner').hidden, true);
    s.events.MiniMode({ isMini: false });
    assert.equal(s.node('update-banner').hidden, false);
    assert.equal(s.window.document.activeElement, focused);
    assert.equal(s.window.document.querySelector('dialog[open]'), null);
    s.ui.openRemoval({ id: 'station-1', name: 'Fixture Station' });
    s.events.UpdateNotice({ version: '1.3.0', currentVersion: '1.1.3' });
    assert.equal(s.node('update-banner').hidden, true);
    s.ui.closeRemoval();
    assert.equal(s.node('update-available-version').textContent, '1.3.0');
    assert.equal(s.ui.state.playerState.isPlaying, true);
    assert.deepEqual(s.calls, []);
});

test('delayed startup checks cannot overwrite a newer pushed notice or reopen a dismissal', async t => {
    const s = setup(t);
    let finish;
    s.window.api.updates = { check: () => new Promise(resolve => { finish = resolve; }) };
    const pending = s.ui.checkUpdates();
    s.events.UpdateNotice({ version: '1.3.0', currentVersion: '1.1.3' });
    finish({ version: '1.2.0', currentVersion: '1.1.3' });
    await pending;
    assert.equal(s.node('update-available-version').textContent, '1.3.0');
    const oldNotice = s.ui.checkUpdates();
    s.events.UpdateNotice(null);
    finish({ version: '1.3.0', currentVersion: '1.1.3' });
    await oldNotice;
    assert.equal(s.node('update-banner').hidden, true);
    assert.equal(s.node('main-header').hidden, true);
});

test('footer thumbs follow the visible player through expanded view, mini mode and navigation', async t => {
    const s = setup(t);
    const thumbs = s.node('mini-thumbs');
    assert.notEqual(thumbs.style.display, 'none');
    s.open();
    await tick();
    assert.equal(thumbs.style.display, 'none');
    for (let i = 0; i < 2; i++) {
        s.events.MiniMode({ isMini: true });
        assert.notEqual(thumbs.style.display, 'none', 'Mini player keeps its only thumb controls');
        assert.equal(s.node('mini-thumb-up').classList.contains('liked'), true);
        s.events.MiniMode({ isMini: false });
        assert.equal(thumbs.style.display, 'none', 'Returning to expanded view must hide duplicate controls again');
        assert.equal(s.node('np-thumbup').classList.contains('liked'), true);
    }
    s.ui.update({ isPlaying: false });
    assert.equal(thumbs.style.display, 'none');
    s.node('np-back-btn').click();
    assert.notEqual(thumbs.style.display, 'none', 'Home restores the bottom-bar controls');
    s.ui.render('search');
    s.events.MiniMode({ isMini: true });
    s.events.MiniMode({ isMini: false });
    assert.notEqual(thumbs.style.display, 'none');
});

test('Home reconciles collection changes immediately and preserves unchanged cards, focus and scroll', t => {
    const s = setup(t);
    const stations = Array.from({ length: 8 }, (_, index) => ({
        id: 'home-' + index, name: 'Radio ' + index, type: 'station',
        lastUpdated: new Date(2025, 0, 8 - index).toISOString()
    }));
    const ids = container => Array.from(container.querySelectorAll('.card'), card => card.dataset.id);
    s.events.Collection(stations);
    const recent = s.node('home-recent');
    const more = s.node('home-more');
    const firstCard = recent.firstElementChild;
    firstCard.focus();
    s.node('main-scroll').scrollTop = 120;
    s.events.Collection(structuredClone(stations));
    assert.equal(s.node('home-recent'), recent);
    assert.equal(recent.firstElementChild, firstCard);
    assert.equal(recent.children.length, 6, 'An unchanged refresh must not detach the cards');
    assert.equal(more.children.length, 2);
    assert.equal(s.window.document.activeElement, firstCard);
    assert.equal(s.node('main-scroll').scrollTop, 120);

    const promotedCard = more.firstElementChild;
    s.events.Collection(stations.filter(station => station.id !== 'home-1'));
    assert.deepEqual(ids(recent), ['home-0', 'home-2', 'home-3', 'home-4', 'home-5', 'home-6']);
    assert.equal(recent.lastElementChild, promotedCard, 'Reuse a card promoted from the second grid');
    assert.deepEqual(ids(more), ['home-7']);
    s.events.Collection(stations.slice(0, 2));
    assert.equal(more.children.length, 0);
    assert.equal(s.node('home-more-section').style.display, 'none');
    s.events.Collection([]);
    assert.equal(recent.querySelector('.card'), null);
    assert.match(recent.textContent, /No stations found/);

    s.ui.render('search');
    const searchView = s.node('page-content').firstElementChild;
    s.events.Collection(stations);
    assert.equal(s.node('page-content').firstElementChild, searchView);
    s.ui.render('home');
    assert.equal(s.node('home-recent').children.length, 6);
});

test('playing a Home or sidebar station immediately reorders recent cards and survives a stale collection refresh', t => {
    const s = setup(t);
    let now = Date.UTC(2026, 0, 1);
    const NativeDate = s.window.Date;
    s.window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [now])); }
    };
    const stations = Array.from({ length: 8 }, (_, index) => ({
        id: 'home-' + index, name: 'Radio ' + index, type: 'station',
        lastUpdated: new Date(2025, 0, 8 - index).toISOString()
    }));
    s.window.api.content.playItem = station => s.calls.push(['play', station.id]);
    s.events.Collection(structuredClone(stations));
    const recent = s.node('home-recent');
    const more = s.node('home-more');
    const selected = more.lastElementChild;
    const displaced = recent.lastElementChild;
    selected.focus();
    s.node('main-scroll').scrollTop = 120;
    selected.click();
    assert.deepEqual(s.calls, [['play', 'home-7']]);
    assert.equal(recent.firstElementChild, selected);
    assert.equal(s.node('stations-list').querySelector('.station-item[data-id]').dataset.id, 'home-7');
    assert.equal(more.firstElementChild, displaced);
    assert.equal(s.window.document.activeElement, selected);
    assert.equal(s.node('main-scroll').scrollTop, 120);
    assert.equal(recent.children.length + more.children.length, 8);
    s.events.Collection(structuredClone(stations));
    assert.equal(recent.firstElementChild, selected, 'Delayed server dates must not undo the selection');
    assert.equal(s.node('stations-list').querySelector('.station-item[data-id]').dataset.id, 'home-7');
    selected.click();
    assert.equal(recent.children.length, 6, 'Replaying the newest card must leave the grid intact');

    now += 1000;
    s.node('stations-list').querySelector('[data-id="home-2"]').click();
    assert.equal(recent.firstElementChild.dataset.id, 'home-2');
    assert.equal(s.node('stations-list').querySelector('.station-item[data-id]').dataset.id, 'home-2');
    assert.deepEqual(s.calls.at(-1), ['play', 'home-2']);
    assert.equal(s.node('home-recent'), recent, 'Keep the Home view mounted');
});

test('artwork opens tuning above history with only available API options and escaped names', async t => {
    const s = setup(t);
    assert.equal(s.node('np-mode-select'), null);
    assert.equal(s.calls.length, 0);
    s.open();
    await tick();
    assert.deepEqual(s.calls, [['get', 'station-1']]);
    assert.equal(s.node('np-mode-select').value, '0');
    assert.deepEqual(Array.from(s.node('np-mode-menu').children, option => option.dataset.modeId), ['0', '1091989', '987654']);
    assert.match(s.node('np-mode-option-987654').textContent, /Curated <Mix>/);
    assert.match(s.node('np-mode-status').textContent, /starts a new song/);
    assert.equal(s.window.document.querySelector('#np-station-tuning mix'), null);
    assert.equal(s.node('np-station-tuning').nextElementSibling.className, 'np-history');
    assert.equal(s.node('np-thumbup').classList.contains('liked'), true);
    const selector = s.node('np-mode-select');
    selector.focus();
    s.ui.update({ isPlaying: false });
    assert.equal(s.node('np-mode-select'), selector, 'Partial playback updates must preserve the selector and its focus');
    assert.equal(s.window.document.activeElement, selector);
    s.node('np-back-btn').click();
    assert.equal(s.node('np-mode-select'), null);
});

test('the selector keeps the confirmed value while waiting and submits the returned ID', async t => {
    const s = setup(t);
    s.open();
    await tick();
    let finish;
    s.player.setStationMode = async (stationId, modeId) => {
        s.calls.push(['set', stationId, modeId]);
        s.ui.update({ stationModes: modes(0, { changing: true }) });
        return new Promise(resolve => { finish = resolve; });
    };
    s.select(1091989);
    assert.deepEqual(s.calls[1], ['set', 'station-1', 1091989]);
    assert.equal(s.node('np-mode-select').value, '0');
    assert.equal(s.node('np-mode-select').disabled, true);
    assert.match(s.node('np-mode-status').textContent, /Changing/);
    s.ui.update({ stationModes: modes(1091989) });
    finish({ success: true });
    await tick();
    assert.equal(s.node('np-mode-select').value, '1091989');
    assert.equal(s.node('np-mode-select').disabled, false);
    assert.equal(s.node('np-mode-description').textContent, 'More energy <without markup>.');
    assert.equal(s.node('np-mode-description').childElementCount, 0);
    assert.equal(s.ui.state.playerState.trackToken, 'current');
    assert.equal(s.ui.state.playerState.feedback, 'thumbUp');
});

test('silent rejection retains the actual mode and IPC failure restores an enabled selector', async t => {
    const s = setup(t);
    s.open();
    await tick();
    s.player.setStationMode = async () => {
        s.ui.update({ stationModes: modes(0, { error: 'Pandora did not enable that mode.' }) });
        return { success: false };
    };
    s.select(1091989);
    await tick();
    assert.equal(s.node('np-mode-select').value, '0');
    assert.match(s.node('np-mode-status').textContent, /did not enable/);
    assert.equal(s.node('np-mode-select').disabled, false);
    s.player.setStationMode = async () => { throw new Error('IPC closed'); };
    s.select(1091989);
    await tick();
    assert.equal(s.node('np-mode-select').disabled, false);
    assert.equal(s.node('np-mode-select').value, '0');
});

test('mode loading errors can be retried and stations without modes get no invented choices', async t => {
    const s = setup(t);
    s.player.getStationModes = async () => {
        s.ui.update({ stationModes: { status: 'error', error: 'Could not load modes.' } });
    };
    s.open();
    await tick();
    assert.equal(s.node('np-mode-select').disabled, true);
    s.player.getStationModes = async () => s.ui.update({ stationModes: modes() });
    s.node('np-mode-retry').click();
    await tick();
    assert.equal(s.node('np-mode-select').disabled, false);
    assert.equal(s.node('np-mode-retry'), null);
    s.ui.update({ stationModes: modes(null, { available: false, modes: [] }) });
    assert.equal(s.node('np-station-tuning').hidden, true);
    assert.equal(s.node('np-mode-select'), null);
});

test('Artist Only appears only when the API confirms station and account eligibility', async t => {
    const s = setup(t);
    s.open();
    await tick();
    assert.equal(s.window.document.querySelector('#np-mode-option-5'), null);
    const eligible = modes();
    eligible.modes.find(mode => mode.id === 5).available = true;
    s.ui.update({ stationModes: eligible });
    assert.equal(s.window.document.querySelector('#np-mode-option-5').disabled, false);
    s.select(5);
    await tick();
    assert.deepEqual(s.calls.at(-1), ['set', 'station-1', 5]);
    s.ui.update({ stationModes: modes(0, { modes: eligible.modes.filter(mode => mode.id !== 5) }) });
    assert.equal(s.window.document.querySelector('#np-mode-option-5'), null);
});

test('Shuffle hides tuning and sends no mode requests; switching back restores eligible options', async t => {
    const s = setup(t);
    s.ui.update({ isShuffle: true });
    s.open();
    await tick();
    assert.equal(s.node('np-station-tuning').hidden, true);
    assert.equal(s.node('np-mode-select'), null);
    assert.equal(s.calls.length, 0);
    s.ui.update({ isShuffle: false, stationId: 'station-2', stationModes: { status: 'idle' } });
    await tick();
    assert.deepEqual(s.calls, [['get', 'station-2']]);
    assert.equal(s.node('np-station-tuning').hidden, false);
    assert.equal(s.node('np-mode-select').value, '0');
    s.ui.update({ isShuffle: true, stationId: 'shuffle', stationModes: { status: 'idle' } });
    assert.equal(s.node('np-mode-select'), null, 'Previously rendered controls are removed');
    assert.equal(s.calls.length, 1);
});

test('a station whose modes are all unavailable hides the tuning panel', async t => {
    const s = setup(t);
    s.player.getStationModes = async () => s.ui.update({ stationModes: modes(null, {
        modes: [{ id: 5, name: 'Artist Only', available: false, premiumOnly: true }]
    }) });
    s.open();
    await tick();
    assert.equal(s.node('np-station-tuning').hidden, true);
    assert.equal(s.node('np-mode-select'), null);
});

test('a stale request failure cannot replace another station’s modes; conflicts disable tuning', async t => {
    const s = setup(t);
    let reject;
    s.player.getStationModes = async () => new Promise((resolve, fail) => { reject = fail; });
    s.open();
    s.player.getStationModes = async () => s.ui.update({ stationModes: modes(1091989) });
    s.ui.update({ stationId: 'station-2', stationName: 'Other Radio', stationModes: { status: 'idle' } });
    await tick();
    reject(new Error('Old station request'));
    await tick();
    assert.equal(s.node('np-mode-select').value, '1091989');
    assert.equal(s.window.document.querySelector('.station-tuning-name').textContent, 'Other Radio');
    s.ui.update({ streamBlocked: true });
    assert.equal(s.node('np-mode-select').disabled, true);
    assert.match(s.node('np-mode-status').textContent, /Resume playback here/);
});

test('restarting the same station loads fresh modes without waiting for an old request', async t => {
    const s = setup(t);
    let rejectOld;
    let reads = 0;
    s.player.getStationModes = async () => {
        reads++;
        if (reads === 1) return new Promise((resolve, reject) => { rejectOld = reject; });
        s.ui.update({ stationModes: modes(1091989) });
    };
    s.open();
    s.ui.update({ playbackGeneration: 2, stationModes: { status: 'idle' } });
    await tick();
    const readsBeforeOldFinished = reads;
    rejectOld(new Error('Obsolete station session'));
    await tick();
    assert.equal(readsBeforeOldFinished, 2, 'The new station session must not be blocked by an old mode request');
    assert.equal(s.node('np-mode-select').value, '1091989');
    assert.equal(s.node('np-mode-select').disabled, false);
    assert.equal(s.node('np-mode-retry'), null);
});

test('the custom mode menu supports keyboard navigation, dismissal and stable focus', async t => {
    const s = setup(t);
    s.open();
    await tick();
    const key = name => s.window.document.activeElement.dispatchEvent(new s.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    s.node('np-mode-select').focus();
    key('ArrowDown');
    assert.equal(s.node('np-mode-select').getAttribute('aria-expanded'), 'true');
    assert.equal(s.window.document.activeElement.id, 'np-mode-option-0');
    key('ArrowDown');
    assert.equal(s.window.document.activeElement.id, 'np-mode-option-1091989');
    s.ui.update({ isPlaying: false });
    assert.equal(s.window.document.activeElement.id, 'np-mode-option-1091989');
    key('End');
    assert.equal(s.window.document.activeElement.id, 'np-mode-option-987654');
    key('Home');
    key('Escape');
    assert.equal(s.node('np-mode-menu').hidden, true);
    assert.equal(s.window.document.activeElement.id, 'np-mode-select');
    assert.equal(s.calls.some(call => call[0] === 'set'), false, 'Browsing or dismissing never changes the mode');
    s.node('np-mode-select').click();
    s.window.document.body.dispatchEvent(new s.window.Event('pointerdown', { bubbles: true }));
    assert.equal(s.node('np-mode-menu').hidden, true);
    s.node('np-mode-select').click();
    s.node('np-back-btn').focus();
    assert.equal(s.node('np-mode-menu').hidden, true, 'Tabbing out dismisses the menu');
});

test('sidebar follows station IDs and Shuffle across song changes and collection rerenders', t => {
    const s = setup(t);
    s.ui.state.stations = [
        { id: 'station-1', name: 'First Radio', type: 'station' },
        { id: 'station-2', name: 'The Current Artist Radio', type: 'station' }
    ];
    s.ui.renderStations();
    const active = () => Array.from(s.window.document.querySelectorAll('#stations-list .active'), item => item.id || item.dataset.id);
    assert.deepEqual(active(), ['station-1']);
    s.ui.update({ artist: 'The Current Artist' });
    assert.deepEqual(active(), ['station-1'], 'The song artist must not determine the station');
    s.ui.update({ stationId: 'shuffle-id', isShuffle: true });
    assert.deepEqual(active(), ['shuffle-stations-btn']);
    s.ui.renderStations();
    assert.deepEqual(active(), ['shuffle-stations-btn']);
    assert.equal(s.node('shuffle-stations-btn').getAttribute('aria-current'), 'true');
    s.ui.update({ stationId: 'station-2', isShuffle: false, track: null, stationLoading: true });
    assert.deepEqual(active(), ['station-2'], 'Station selection updates even while the first song loads');
    assert.equal(s.node('shuffle-stations-btn').hasAttribute('aria-current'), false);
    s.ui.update({ stationId: null });
    assert.deepEqual(active(), []);
});

test('the in-app listening dialog defaults to keeping playback paused and only submits explicit choices', async t => {
    const s = setup(t);
    s.ui.update({ streamBlocked: true, streamPrompt: { id: 7, pending: false } });
    assert.equal(s.node('stream-conflict-dialog').open, true);
    assert.equal(s.window.document.activeElement.id, 'stream-keep-listening');
    assert.equal(s.calls.length, 0);
    s.node('stream-conflict-dialog').dispatchEvent(new s.window.Event('cancel', { cancelable: true }));
    await tick();
    assert.deepEqual(s.calls, [['takeover', 7, false]]);
    assert.equal(s.node('stream-conflict-dialog').open, false);
    s.ui.update({ streamPrompt: { id: 8, pending: false } });
    s.node('stream-dialog-close').click();
    await tick();
    assert.deepEqual(s.calls.at(-1), ['takeover', 8, false]);
    let finish;
    s.player.resolveStreamConflict = async (id, takeOver) => {
        s.calls.push(['takeover', id, takeOver]);
        return new Promise(resolve => { finish = resolve; });
    };
    s.ui.update({ streamPrompt: { id: 9, pending: false } });
    s.node('stream-take-over').click();
    s.node('stream-take-over').click();
    s.node('stream-conflict-dialog').dispatchEvent(new s.window.Event('cancel', { cancelable: true }));
    assert.equal(s.calls.filter(call => call[1] === 9).length, 1);
    assert.deepEqual(s.calls.at(-1), ['takeover', 9, true]);
    assert.equal(s.node('stream-keep-listening').disabled, true);
    assert.equal(s.node('stream-dialog-status').hidden, false);
    s.ui.update({ streamPrompt: null });
    finish({ success: true });
    await tick();
    assert.equal(s.node('stream-conflict-dialog').open, false);
});

test('sidebar and Library removal use confirmation; Cancel, close and Escape never remove or play a station', async t => {
    const s = setup(t);
    s.ui.state.stations = [{ id: 'station-1', name: 'Thunder <Live> "Radio"', type: 'station' }];
    s.ui.renderStations();
    s.window.api.content.playItem = () => s.calls.push(['play']);
    s.window.api.content.removeStation = async id => { s.calls.push(['remove', id]); return true; };
    s.ui.render('library');
    for (const selector of ['.delete-btn', '#library-cards .card-remove-button']) {
        for (const action of ['station-remove-cancel', 'station-remove-close', 'Escape']) {
            s.window.document.querySelector(selector).click();
            assert.equal(s.node('station-remove-dialog').open, true);
            assert.equal(s.window.document.activeElement.id, 'station-remove-cancel');
            assert.equal(s.node('station-remove-name').textContent, 'Thunder <Live> "Radio"');
            assert.equal(s.node('station-remove-name').childElementCount, 0);
            if (action === 'Escape') s.node('station-remove-dialog').dispatchEvent(new s.window.Event('cancel', { cancelable: true }));
            else s.node(action).click();
            await tick();
            assert.equal(s.node('station-remove-dialog').open, false);
        }
    }
    assert.deepEqual(s.calls, []);
});

test('filtered Library removes the confirmed station ID when names repeat and updates both views', async t => {
    const s = setup(t);
    const name = 'Thunder <Live> "Radio"';
    const stations = [
        { id: 'station-b', name, type: 'station' },
        { id: 'station-a', name, type: 'station' },
        { id: 'mix', name: 'Shuffle', isShuffle: true },
        { id: 'other', name: 'Other Radio', type: 'station' }
    ];
    s.events.Collection(stations);
    s.ui.render('library');
    assert.equal(s.node('library-shuffle-card').querySelector('.card-remove-button'), null);
    s.ui.state.libraryFilter = '"Radio"';
    s.ui.render('library');
    assert.equal(s.node('library-filter').value, '"Radio"');
    assert.equal(s.node('library-cards').querySelectorAll('.card').length, 2);
    const remove = s.node('library-cards').querySelector('[data-id="station-a"] .card-remove-button');
    assert.equal(remove.getAttribute('aria-label'), 'Remove ' + name);
    s.window.api.content.playItem = () => s.calls.push(['play']);
    s.window.api.content.removeStation = async id => {
        s.calls.push(['remove', id]);
        s.events.Collection(stations.filter(station => station.id !== id));
        return true;
    };
    remove.click();
    assert.deepEqual(s.calls, [], 'The X must neither start playback nor delete without confirmation');
    s.node('station-remove-confirm').click();
    await tick();
    assert.deepEqual(s.calls, [['remove', 'station-a']]);
    assert.equal(s.node('station-remove-dialog').open, false);
    assert.equal(s.node('library-filter').value, '"Radio"', 'Keep the search after removing a result');
    assert.equal(s.window.document.activeElement, s.node('library-filter'));
    assert.equal(s.node('library-cards').querySelector('[data-id="station-a"]'), null);
    assert.equal(s.node('stations-list').querySelector('[data-id="station-a"]'), null);
    assert.ok(s.node('library-cards').querySelector('[data-id="station-b"]'), 'Keep the other identically named station');
    s.ui.render('home');
    assert.equal(s.node('home-recent').querySelector('[data-id="station-a"]'), null);
    assert.ok(s.node('home-recent').querySelector('[data-id="station-b"] .card-remove-button'));
    assert.equal(s.node('home-recent').querySelector('[data-id="mix"] .card-remove-button'), null);
});

test('Home removes from either grid without playing, while Shuffle has no removal on either page', async t => {
    const s = setup(t);
    const stations = Array.from({ length: 8 }, (_, i) => ({ id: 'station-' + i, name: 'Station ' + i,
        type: 'station', lastUpdated: new Date(2025, 0, 10 - i).toISOString() }));
    stations.push({ id: 'mix', name: 'Shuffle Stations', isShuffle: true });
    s.events.Collection(stations);
    s.window.api.content.playItem = () => s.calls.push(['play']);
    s.window.api.content.removeStation = async id => {
        s.calls.push(['remove', id]);
        s.events.Collection(s.ui.state.stations.filter(station => station.id !== id));
        return true;
    };
    assert.equal(s.node('home-more').querySelector('[data-id="mix"] .card-remove-button'), null);
    for (const [grid, id] of [['home-recent', 'station-0'], ['home-more', 'station-7']]) {
        s.node(grid).querySelector('[data-id="' + id + '"] .card-remove-button').click();
        assert.equal(s.node('station-remove-dialog').open, true);
        s.node('station-remove-confirm').click();
        await tick();
        assert.deepEqual(s.calls.at(-1), ['remove', id]);
        assert.equal(s.window.document.querySelector('.card[data-id="' + id + '"]'), null);
    }
    assert.equal(s.calls.some(call => call[0] === 'play'), false);
    assert.ok(s.window.document.querySelector('.card[data-id="mix"]'));
    s.ui.render('library');
    assert.equal(s.node('library-shuffle-card').querySelector('.card-remove-button'), null);
    s.ui.openRemoval({ id: 'mix', name: 'Shuffle Stations', isShuffle: true });
    assert.equal(s.node('station-remove-dialog').open, false);
});

test('station removal submits the confirmed ID once, survives a sidebar refresh, and handles failure with retry', async t => {
    const s = setup(t);
    s.ui.state.stations = [{ id: 'station-1', name: 'First Radio', type: 'station' }];
    s.ui.renderStations();
    let finish;
    s.window.api.content.removeStation = async id => {
        s.calls.push(['remove', id]);
        return new Promise(resolve => { finish = resolve; });
    };
    s.window.document.querySelector('.delete-btn').click();
    s.node('station-remove-confirm').click();
    s.node('station-remove-confirm').click();
    s.node('station-remove-dialog').dispatchEvent(new s.window.Event('cancel', { cancelable: true }));
    assert.deepEqual(s.calls, [['remove', 'station-1']]);
    assert.equal(s.node('station-remove-dialog').open, true);
    assert.equal(s.node('station-remove-cancel').disabled, true);
    assert.equal(s.node('station-remove-status').hidden, false);
    s.ui.state.stations.unshift({ id: 'station-2', name: 'Other Radio', type: 'station' });
    s.ui.renderStations();
    finish(false);
    await tick();
    assert.equal(s.node('station-remove-dialog').open, true);
    assert.equal(s.node('station-remove-error').hidden, false);
    assert.equal(s.node('station-remove-confirm').disabled, false);
    s.node('station-remove-confirm').click();
    assert.deepEqual(s.calls.at(-1), ['remove', 'station-1']);
    finish(true);
    await tick();
    assert.equal(s.node('station-remove-dialog').open, false);
});

test('station removal recovers from an IPC exception without leaving controls disabled', async t => {
    const s = setup(t);
    s.ui.state.stations = [{ id: 'station-1', name: 'First Radio', type: 'station' }];
    s.ui.renderStations();
    s.window.api.content.removeStation = async () => { throw new Error('IPC unavailable'); };
    s.window.document.querySelector('.delete-btn').click();
    s.node('station-remove-confirm').click();
    await tick();
    assert.equal(s.node('station-remove-dialog').open, true);
    assert.equal(s.node('station-remove-confirm').disabled, false);
    assert.equal(s.node('station-remove-cancel').disabled, false);
    assert.match(s.node('station-remove-error').textContent, /try again/);
    s.node('station-remove-cancel').click();
    assert.equal(s.node('station-remove-dialog').open, false);
});
