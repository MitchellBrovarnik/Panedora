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
