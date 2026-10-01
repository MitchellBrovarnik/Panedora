/**
 * Display Pandora's HUMAN challenge for the user to complete.
 * The window uses the API's Chromium session; no CAPTCHA is solved by the app.
 */

const path = require('path');
const { BrowserWindow, ipcMain, session } = require('electron');

const PANDORA_ORIGIN = 'https://www.pandora.com';
const VERIFIED_CHANNEL = 'PANDORA:VERIFICATION_COMPLETE';
const CANCEL_CHANNEL = 'PANDORA:VERIFICATION_CANCEL';

function isPandoraUrl(value) {
    try {
        const url = new URL(value);
        return url.origin === PANDORA_ORIGIN && !url.username && !url.password;
    } catch {
        return false;
    }
}

function normalizeChallenge(error, blockedUrl) {
    if (error?.status !== 403 || Number(error.errorCode) !== 1215 ||
        !/^PX[a-zA-Z0-9]{1,32}$/.test(error.appId || '') ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(error.uuid || '') ||
        !isPandoraUrl(blockedUrl)) {
        throw new Error('Invalid Pandora verification response');
    }

    const prefix = '/' + error.appId.slice(2);
    const resource = (value, expectedPath) => {
        if (typeof value !== 'string') throw new Error('Missing verification resource');
        const url = new URL(value, PANDORA_ORIGIN);
        if (!isPandoraUrl(url.href) || url.pathname !== expectedPath) {
            throw new Error('Unexpected verification resource');
        }
        return url.href;
    };
    let altBlockScript = null;
    if (error.altBlockScript) {
        const url = new URL(error.altBlockScript);
        if (url.origin !== 'https://captcha.px-cloud.net' || url.username || url.password ||
            url.pathname !== '/' + error.appId + '/captcha.js') {
            throw new Error('Unexpected alternate verification resource');
        }
        altBlockScript = url.href;
    }

    return {
        appId: error.appId,
        uuid: error.uuid,
        vid: typeof error.vid === 'string' ? error.vid : null,
        firstPartyEnabled: error.firstPartyEnabled === true,
        jsClientSrc: resource(error.jsClientSrc, prefix + '/init.js'),
        hostUrl: resource(error.hostUrl, prefix + '/xhr'),
        blockScript: resource(error.blockScript, prefix + '/captcha'),
        altBlockScript,
        blockedUrl
    };
}

function buildChallengeScript(challenge) {
    // Use data literals, never server-provided JavaScript or HTML. Escaping '<'
    // also makes the generated script safe if it is later embedded in HTML.
    const data = JSON.stringify(challenge).replace(/</g, '\\u003c');
    return `(() => {
        const challenge = ${data};
        window._pxMonitorAbr = false;
        window._pxBlockedUrl = challenge.blockedUrl;
        window._pxAppId = challenge.appId;
        window._pxJsClientSrc = challenge.jsClientSrc;
        window._pxFirstPartyEnabled = challenge.firstPartyEnabled;
        window._pxVid = challenge.vid;
        window._pxUuid = challenge.uuid;
        window._pxHostUrl = challenge.hostUrl;
        window._pxOnCaptchaSuccess = (isValid) => {
            if (isValid === true) window.panedoraVerification.complete();
        };

        document.title = 'Pandora verification';
        const panel = document.createElement('main');
        panel.setAttribute('aria-label', 'Pandora verification');
        panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#10121a;color:#f2f3f7;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;box-sizing:border-box;text-align:center;';
        panel.innerHTML = '<h1 style="font-size:24px;margin:0">Verify with Pandora</h1><p style="font-size:14px;line-height:1.5;max-width:440px;margin:0;color:#bec3d0">Complete the check below. Panedora will then retry your sign-in automatically.</p><div id="px-captcha"></div><p id="verification-load-error" role="alert" style="display:none;max-width:440px;font-size:14px;color:#ffaaaa">The verification check could not load. Close this window and try signing in again.</p><button id="verification-cancel" type="button" style="border:1px solid #51596b;border-radius:8px;background:#222837;color:#f2f3f7;padding:10px 20px;font:inherit;cursor:pointer">Cancel</button>';
        document.body.replaceChildren(panel);
        document.getElementById('verification-cancel').addEventListener('click', () => window.panedoraVerification.cancel());

        // HUMAN's documented Custom ABR flow: display the original challenge
        // script and wait for its callback after the user's interaction.
        const loadChallenge = (source, canUseAlternate) => {
            const script = document.createElement('script');
            script.src = source;
            script.onerror = () => {
                if (canUseAlternate && challenge.altBlockScript) {
                    // A failed script must be replaced; changing src on an
                    // already-started script does not execute a new load.
                    loadChallenge(challenge.altBlockScript, false);
                    return;
                }
                document.getElementById('verification-load-error').style.display = 'block';
            };
            document.head.appendChild(script);
        };
        loadChallenge(challenge.blockScript, true);
    })()`;
}

class PandoraVerification {
    constructor() {
        this.window = null;
        this.pending = null;
        this.ready = false;
    }

    ownsWebContents(contents) {
        return this.window?.webContents === contents;
    }

    cancel() {
        if (this.window && !this.window.isDestroyed()) this.window.destroy();
    }

    show(error, blockedUrl, { parent, userAgent } = {}) {
        const challenge = normalizeChallenge(error, blockedUrl);
        if (this.pending) {
            if (this.ready) {
                this.window.show();
                this.window.focus();
            }
            return this.pending;
        }

        const win = new BrowserWindow({
            width: 580,
            height: 600,
            minWidth: 480,
            minHeight: 480,
            title: 'Pandora verification',
            parent,
            modal: !!parent,
            show: false,
            autoHideMenuBar: true,
            backgroundColor: '#10121a',
            webPreferences: {
                session: session.defaultSession,
                preload: path.join(__dirname, 'preload-verification.js'),
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false
            }
        });
        this.window = win;
        win.webContents.setUserAgent(userAgent || session.defaultSession.getUserAgent());
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

        this.pending = new Promise((resolve, reject) => {
            let settled = false;
            const finish = (verified, failure) => {
                if (settled) return;
                settled = true;
                clearTimeout(loadTimeout);
                ipcMain.removeListener(VERIFIED_CHANNEL, onVerified);
                ipcMain.removeListener(CANCEL_CHANNEL, onCancel);
                this.window = null;
                this.pending = null;
                this.ready = false;
                if (!win.isDestroyed()) win.destroy();
                if (failure) reject(failure);
                else resolve(verified);
            };
            const onVerified = (event) => {
                if (event.sender !== win.webContents) return;
                // Cookies are already in Chromium's jar. Persist them as well so
                // verification can survive the next app restart.
                session.defaultSession.cookies.flushStore()
                    .catch(e => console.warn('[Verification] Cookie persistence failed:', e.message))
                    .then(() => finish(true));
            };
            const onCancel = (event) => {
                if (event.sender === win.webContents) finish(false);
            };
            const loadTimeout = setTimeout(() => finish(false, new Error('Verification page timed out')), 30000);
            ipcMain.on(VERIFIED_CHANNEL, onVerified);
            ipcMain.on(CANCEL_CHANNEL, onCancel);
            win.once('closed', () => finish(false));

            win.webContents.on('will-navigate', (event, url) => {
                if (!isPandoraUrl(url)) {
                    event.preventDefault();
                    finish(false, new Error('Unexpected verification navigation'));
                }
            });
            win.webContents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
                if (isMainFrame !== false && !isPandoraUrl(url)) {
                    event.preventDefault();
                    finish(false, new Error('Unexpected verification redirect'));
                }
            });
            win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
                if (isMainFrame !== false && code !== -3) {
                    finish(false, new Error('Verification page failed to load: ' + description));
                }
            });
            win.webContents.once('did-finish-load', async () => {
                if (settled) return;
                try {
                    if (!isPandoraUrl(win.webContents.getURL())) {
                        throw new Error('Unexpected verification origin');
                    }
                    // Establish the genuine Pandora origin for its scripts and
                    // cookies, then show only the challenge. The full site is
                    // never displayed and receives no credentials from Panedora.
                    await win.webContents.executeJavaScript(buildChallengeScript(challenge));
                    if (!settled) {
                        clearTimeout(loadTimeout);
                        this.ready = true;
                        win.show();
                    }
                } catch (e) {
                    finish(false, e);
                }
            });
            win.loadURL(PANDORA_ORIGIN + '/').catch(e => finish(false, e));
        });
        return this.pending;
    }
}

module.exports = { PandoraVerification, normalizeChallenge, buildChallengeScript };
