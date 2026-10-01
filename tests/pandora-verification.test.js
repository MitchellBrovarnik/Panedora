const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { loadModule, challenge } = require('./test-helpers');

function setup() {
    const windows = [];
    const ipcMain = new EventEmitter();
    const session = { defaultSession: { getUserAgent: () => 'shared browser', cookies: { flushStore: async () => {} } } };
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.destroyed = false;
            this.shown = false;
            this.webContents = new EventEmitter();
            this.webContents.setUserAgent = agent => { this.agent = agent; };
            this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
            this.webContents.getURL = () => this.url;
            this.webContents.executeJavaScript = async script => { this.script = script; };
            windows.push(this);
        }
        loadURL(url) { this.url = url; return Promise.resolve(); }
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; this.emit('closed'); }
        show() { this.shown = true; }
        focus() {}
    }
    const exports = loadModule(path.join(__dirname, '..', 'pandora-verification.js'), { electron: { BrowserWindow, ipcMain, session } });
    return { ...exports, windows, ipcMain, session };
}

const blockedUrl = 'https://www.pandora.com/api/v1/auth/login';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('only Pandora challenge resources are accepted', () => {
    const { normalizeChallenge } = setup();
    assert.equal(normalizeChallenge(challenge, blockedUrl).blockScript, 'https://www.pandora.com' + challenge.blockScript);
    for (const blockScript of ['https://evil.invalid/captcha', '//evil.invalid/captcha', 'javascript:alert(1)', 'https://www.pandora.com@evil.invalid/XljWHHUe/captcha', '/unrelated-script']) {
        assert.throws(() => normalizeChallenge({ ...challenge, blockScript }, blockedUrl));
    }
    assert.throws(() => normalizeChallenge(challenge, 'https://evil.invalid/api/v1/auth/login'));
    assert.throws(() => normalizeChallenge({ ...challenge, status: 401 }, blockedUrl));
    assert.throws(() => normalizeChallenge({ ...challenge, altBlockScript: 'https://evil.invalid/captcha.js' }, blockedUrl));
    assert.equal(normalizeChallenge({ ...challenge, altBlockScript: 'https://captcha.px-cloud.net/PXXljWHHUe/captcha.js?a=c' }, blockedUrl).altBlockScript,
        'https://captcha.px-cloud.net/PXXljWHHUe/captcha.js?a=c');
});

test('challenge stays hidden until prepared and uses the shared sandboxed session', async () => {
    const { PandoraVerification, windows, ipcMain, session } = setup();
    const verifier = new PandoraVerification();
    const pending = verifier.show(challenge, blockedUrl);
    const win = windows[0];
    assert.equal(win.shown, false);
    assert.equal(win.options.webPreferences.session, session.defaultSession);
    assert.equal(win.options.webPreferences.sandbox, true);
    assert.equal(win.options.webPreferences.nodeIntegration, false);
    assert.equal(win.options.webPreferences.contextIsolation, true);
    win.webContents.emit('did-finish-load');
    await tick();
    assert.equal(win.shown, true);
    assert.match(win.script, /px-captcha/);
    assert.equal(win.openHandler().action, 'deny');
    ipcMain.emit('PANDORA:VERIFICATION_COMPLETE', { sender: {} });
    await tick();
    assert.equal(win.destroyed, false, 'Unrelated renderer cannot complete verification');
    ipcMain.emit('PANDORA:VERIFICATION_COMPLETE', { sender: win.webContents });
    assert.equal(await pending, true);
    assert.equal(win.destroyed, true);
    assert.equal(ipcMain.listenerCount('PANDORA:VERIFICATION_COMPLETE'), 0);
});

test('concurrent blocked requests share one modal and closing it cancels both', async () => {
    const { PandoraVerification, windows, ipcMain } = setup();
    const verifier = new PandoraVerification();
    const first = verifier.show(challenge, blockedUrl);
    const second = verifier.show(challenge, blockedUrl);
    assert.equal(first, second);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].shown, false, 'Concurrent request must not reveal the full website');
    verifier.cancel();
    assert.equal(await first, false);
    assert.equal(await second, false);
    assert.equal(ipcMain.listenerCount('PANDORA:VERIFICATION_COMPLETE'), 0);
});

test('leaving the trusted origin closes the challenge with a load error', async () => {
    const { PandoraVerification, windows } = setup();
    const pending = new PandoraVerification().show(challenge, blockedUrl);
    let prevented = false;
    windows[0].webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://evil.invalid/');
    await assert.rejects(pending, /Unexpected verification navigation/);
    assert.equal(prevented, true);
});

test('only the provider success callback completes the visible challenge', () => {
    const { normalizeChallenge, buildChallengeScript } = setup();
    const elements = new Map();
    function element() { return { style: {}, setAttribute() {}, addEventListener() {} }; }
    elements.set('verification-cancel', element());
    elements.set('verification-load-error', element());
    let completions = 0;
    let cancellations = 0;
    const appendedScripts = [];
    const window = { panedoraVerification: { complete: () => completions++, cancel: () => cancellations++ } };
    const document = {
        createElement: () => element(),
        body: { replaceChildren() {} },
        head: { appendChild(script) { appendedScripts.push(script); } },
        getElementById: id => elements.get(id)
    };
    const altBlockScript = 'https://captcha.px-cloud.net/PXXljWHHUe/captcha.js?a=c';
    vm.runInNewContext(buildChallengeScript(normalizeChallenge({ ...challenge, altBlockScript }, blockedUrl)), { window, document });
    window._pxOnCaptchaSuccess(false);
    window._pxOnCaptchaSuccess(undefined);
    assert.equal(completions, 0);
    window._pxOnCaptchaSuccess(true);
    assert.equal(completions, 1);
    assert.equal(cancellations, 0);
    assert.equal(appendedScripts[0].src, 'https://www.pandora.com' + challenge.blockScript);
    appendedScripts[0].onerror();
    assert.equal(appendedScripts.length, 2);
    assert.equal(appendedScripts[1].src, altBlockScript);
    appendedScripts[1].onerror();
    assert.equal(elements.get('verification-load-error').style.display, 'block');
});
