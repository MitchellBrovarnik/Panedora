/**
 * Native Electron integration smoke test with a fully local provider fixture.
 * No real Pandora requests or real CAPTCHA interactions are made.
 * Run with: electron tests/electron-verification-smoke.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, session } = require('electron');
const { challenge } = require('./test-helpers');

const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'panedora-verification-test-'));
app.setPath('userData', testData);
app.disableHardwareAcceleration();
const deadline = setTimeout(() => {
    console.error('Native verification test timed out');
    app.exit(1);
}, 20000);

async function waitFor(check) {
    const end = Date.now() + 5000;
    while (!await check()) {
        if (Date.now() > end) throw new Error('Fixture did not become ready');
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

app.whenReady().then(async () => {
    const requests = [];
    const scripts = [];
    const fixtureChallenge = {
        ...challenge,
        altBlockScript: 'https://captcha.px-cloud.net/PXXljWHHUe/captcha.js?a=c'
    };
    // All HTTPS requests are intercepted here; the test never reaches a site.
    session.defaultSession.protocol.handle('https', async request => {
        const url = new URL(request.url);
        if (url.origin === 'https://www.pandora.com' && url.pathname === '/') {
            return new Response('<!doctype html><title>Fixture</title><body>Full site fixture must stay hidden.</body>',
                { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        if (url.pathname === '/api/v1/auth/login') {
            requests.push({ headers: request.headers, body: await request.text() });
            if (requests.length === 1) {
                return new Response(JSON.stringify(fixtureChallenge), { status: 403, headers: { 'Content-Type': 'application/json' } });
            }
            const cookies = await session.defaultSession.cookies.get({ url: request.url });
            assert.ok(cookies.some(c => c.name === '_px3' && c.value === 'fixture-verification'));
            assert.equal(request.headers.get('X-CsrfToken'), 'fixture-browser-csrf');
            assert.equal(request.headers.get('X-AuthToken'), null);
            return new Response(JSON.stringify({ authToken: 'fixture-token', config: { branding: 'PandoraPlus' } }),
                { headers: { 'Content-Type': 'application/json' } });
        }
        if (url.pathname === '/XljWHHUe/captcha') {
            scripts.push('first-party');
            return new Response('Fixture first-party load failure', { status: 404 });
        }
        if (url.origin === 'https://captcha.px-cloud.net' && url.pathname === '/PXXljWHHUe/captcha.js') {
            scripts.push('alternate');
            return new Response(`
                const fixture = document.createElement('button');
                fixture.id = 'fixture-verify';
                fixture.textContent = 'Test provider fixture — Complete verification';
                fixture.style.cssText = 'display:block;padding:24px;width:360px;max-width:100%;background:#f4f4f4;border:0;border-radius:6px;font:14px system-ui;color:#202020';
                fixture.onclick = () => {
                    document.cookie = 'csrftoken=fixture-browser-csrf; Domain=.pandora.com; Path=/; Secure';
                    document.cookie = '_px3=fixture-verification; Domain=.pandora.com; Path=/; Secure';
                    window._pxOnCaptchaSuccess(true);
                };
                document.getElementById('px-captcha').appendChild(fixture);
            `, { headers: { 'Content-Type': 'application/javascript' } });
        }
        return new Response('Unexpected fixture URL', { status: 404 });
    });

    const API = require('../pandora-api');
    const { PandoraVerification } = require('../pandora-verification');
    const verifier = new PandoraVerification();
    const api = new API();
    api.onVerificationRequired = (error, url) => verifier.show(error, url, { userAgent: api.getUserAgent() });
    const login = api.login('fixture@example.invalid', 'fixture-password');
    await waitFor(() => verifier.ready);
    const win = verifier.window;
    await waitFor(() => win.webContents.executeJavaScript("!!document.getElementById('fixture-verify')"));
    assert.equal(win.isVisible(), true);
    assert.equal(requests.length, 1, 'Sign-in must wait for the fixture completion');
    assert.equal(await win.webContents.executeJavaScript("document.body.innerText.includes('Full site fixture')"), false);
    assert.deepEqual(scripts, ['first-party', 'alternate']);
    // Check the actual rendered popup before activating the local test fixture.
    const screenshot = path.join(testData, 'verification-popup.png');
    fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("window._pxOnCaptchaSuccess(false)");
    assert.equal(win.isDestroyed(), false);
    await win.webContents.executeJavaScript("document.getElementById('fixture-verify').click()");
    const result = await login;
    assert.equal(result.success, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(verifier.window, null);
    assert.equal(verifier.pending, null);
    console.log('Native verification smoke test passed: shared cookies, sandboxed preload, CAPTCHA-only popup, CDN fallback, one retry.');
    console.log('Popup screenshot: ' + screenshot);
    clearTimeout(deadline);
    app.quit();
}).catch(error => {
    clearTimeout(deadline);
    console.error(error);
    app.exit(1);
});
