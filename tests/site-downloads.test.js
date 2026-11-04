const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const releasePage = 'https://github.com/MitchellBrovarnik/Panedora/releases/latest';
const asset = name => ({ name, browser_download_url: 'https://github.com/MitchellBrovarnik/Panedora/releases/download/v1.2.0/' + name });
async function setup(t, response) {
    const root = path.join(__dirname, '..', 'docs');
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
        url: 'https://panedora.app/', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    t.after(() => window.close());
    const requests = [];
    window.IntersectionObserver = class { observe() {} };
    window.fetch = async (url, init) => { requests.push({ url, init }); return response(); };
    await new Promise(resolve => window.document.readyState === 'loading'
        ? window.document.addEventListener('DOMContentLoaded', resolve, { once: true }) : resolve());
    window.eval(fs.readFileSync(path.join(root, 'script.js'), 'utf8'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await new Promise(resolve => setImmediate(resolve));
    return { window, requests, node: id => window.document.getElementById(id) };
}

test('website links the stable release installers and labels a single macOS architecture', async t => {
    const s = await setup(t, () => ({ ok: true, json: async () => ({
        tag_name: 'v1.2.0', draft: false, prerelease: false,
        assets: ['Panedora.exe', 'Panedora-arm64.dmg', 'Panedora.AppImage'].map(asset)
    }) }));
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].init.credentials, 'omit');
    assert.equal(s.requests[0].init.referrerPolicy, 'no-referrer');
    assert.equal(s.node('download-win').href, asset('Panedora.exe').browser_download_url);
    assert.equal(s.node('download-linux').href, asset('Panedora.AppImage').browser_download_url);
    assert.equal(s.node('download-mac').href, asset('Panedora-arm64.dmg').browser_download_url);
    assert.match(s.node('download-mac').textContent, /Apple Silicon/);
    assert.match(s.node('download-mac').getAttribute('aria-label'), /Apple Silicon/);
    assert.equal(s.node('latest-release-label').textContent, 'Latest release: v1.2.0');
    for (const el of s.window.document.querySelectorAll('link[rel="stylesheet"],script[src]')) {
        assert.equal(new URL(el.href || el.src).origin, 'https://panedora.app', 'Typography, icons and scripts are served locally');
    }
});

test('multiple macOS builds link to the release page so users can choose their architecture', async t => {
    const s = await setup(t, () => ({ ok: true, json: async () => ({
        tag_name: 'v1.2.0', draft: false, prerelease: false,
        assets: [asset('Panedora-arm64.dmg'), asset('Panedora-x64.dmg')]
    }) }));
    assert.equal(s.node('download-mac').href, releasePage);
    assert.match(s.node('download-mac').textContent, /Choose a macOS build/);
});

test('the local interactive demo activates only after its own ready message', async t => {
    const s = await setup(t, () => ({ ok: true, json: async () => ({
        tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [asset('Panedora.exe')]
    }) }));
    const document = s.window.document;
    const demo = document.getElementById('panedora-demo');
    assert.equal(demo.src, 'https://panedora.app/demo/index.html?v=2');
    assert.equal(demo.hidden, true);
    assert.equal(document.getElementById('demo-fallback').hidden, false);
    const send = (source, origin) => s.window.dispatchEvent(new s.window.MessageEvent('message', {
        source, origin, data: { type: 'panedora-demo-ready' }
    }));
    send(s.window, 'https://panedora.app');
    send(demo.contentWindow, 'https://untrusted.invalid');
    assert.equal(demo.hidden, true, 'Unrelated windows cannot activate the preview');
    send(demo.contentWindow, 'https://panedora.app');
    assert.equal(demo.hidden, false);
    assert.equal(document.getElementById('demo-fallback').hidden, true);
    assert.equal(document.getElementById('demo-frame').getAttribute('aria-busy'), 'false');
    assert.equal(s.requests.length, 1, 'Only the normal release lookup makes a service request');
    assert.equal(s.node('download-win').href, asset('Panedora.exe').browser_download_url);
});

test('demo theme messages update only its surrounding glow and require its own window and origin', async t => {
    const s = await setup(t, () => ({ ok: false }));
    const document = s.window.document;
    const demo = s.node('panedora-demo'), frame = s.node('demo-frame');
    const pageStyles = [document.documentElement, document.body, document.querySelector('.site-header'), document.querySelector('.btn')]
        .map(node => [node, node.getAttribute('style')]);
    const send = (accent, source = demo.contentWindow, origin = 'https://panedora.app', type = 'panedora-demo-theme') =>
        s.window.dispatchEvent(new s.window.MessageEvent('message', { source, origin, data: { type, accent } }));
    send('#10b981', s.window);
    send('#10b981', demo.contentWindow, 'https://untrusted.invalid');
    send('#10b981', demo.contentWindow, 'https://panedora.app', 'unrelated');
    for (const accent of [null, {}, 'red; background: white', 'url(https://untrusted.invalid)', 'linear-gradient(red, blue)']) send(accent);
    assert.equal(frame.style.getPropertyValue('--demo-accent'), '');
    send('#10b981');
    assert.equal(frame.style.getPropertyValue('--demo-accent'), '#10b981');
    send('rgb(75, 100, 190)');
    assert.equal(frame.style.getPropertyValue('--demo-accent'), 'rgb(75, 100, 190)', 'Adaptive artwork accents are accepted');
    send('#7c5bf5');
    assert.equal(frame.style.getPropertyValue('--demo-accent'), '#7c5bf5', 'Reset can restore the default accent');
    for (const [node, style] of pageStyles) assert.equal(node.getAttribute('style'), style, 'The website keeps its own colors');
    assert.equal(demo.hidden, true, 'A theme message does not bypass the ready handshake');
    assert.equal(s.requests.length, 1, 'Theme changes add no network requests');
});

test('release failures, preview releases and foreign asset URLs keep safe download links', async t => {
    for (const response of [
        () => { throw new Error('Offline'); }, () => ({ ok: false }),
        () => ({ ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } }),
        () => ({ ok: true, json: async () => ({ draft: true, prerelease: false, assets: [asset('Panedora.exe')] }) }),
        () => ({ ok: true, json: async () => ({ draft: false, prerelease: true, assets: [asset('Panedora.exe')] }) }),
        () => ({ ok: true, json: async () => ({ draft: false, prerelease: false,
            tag_name: '<img src=x>', assets: [{ name: 'Panedora.exe', browser_download_url: 'https://untrusted.invalid/Panedora.exe' }] }) })
    ]) {
        const s = await setup(t, response);
        for (const id of ['download-win', 'download-mac', 'download-linux']) assert.equal(s.node(id).href, releasePage);
        assert.equal(s.node('latest-release-label').textContent, '');
    }
});
