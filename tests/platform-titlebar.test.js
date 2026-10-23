const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');

function load(api) {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
        url: 'https://panedora.test/', runScripts: 'outside-only', pretendToBeVisual: true
    });
    const { window } = dom;
    if (api !== undefined) Object.defineProperty(window, 'api', { value: api, configurable: true });
    window.eval(fs.readFileSync(path.join(root, 'components.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(root, 'renderer.js'), 'utf8') + `
        document.removeEventListener('DOMContentLoaded', init);
        applyPlatformTitlebar();
    `);
    return window;
}

const isMac = window => window.document.body.classList.contains('platform-mac');

test('darwin gets the macOS title bar', t => {
    const window = load({ platform: 'darwin' });
    t.after(() => window.close());
    assert.equal(isMac(window), true);
});

test('other platforms keep the default title bar', t => {
    for (const platform of ['win32', 'linux', null, undefined, '']) {
        const window = load({ platform });
        assert.equal(isMac(window), false, String(platform));
        window.close();
    }
});

test('missing or throwing api falls back to default', t => {
    const missing = load(undefined);
    assert.equal(isMac(missing), false);
    missing.close();

    const throwing = load({ get platform() { throw new Error('boom'); } });
    assert.equal(isMac(throwing), false);
    throwing.close();
});
