// Exercise the actual Windows Settings page, isolated preload and native keys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, session, globalShortcut } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'panedora-shortcuts-test-')));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error('Windows shortcut test timed out'); app.exit(1); }, 60000);

async function waitFor(check, description) {
    const end = Date.now() + 6000;
    while (!await check()) {
        if (Date.now() > end) throw new Error('Timed out: ' + description);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

function pressKey(key, modifiers = []) {
    execFileSync('python', ['-c', `
import ctypes, json, sys
user32 = ctypes.windll.user32
keys = json.loads(sys.argv[1]) + [int(sys.argv[2])]
try:
    for key in keys:
        user32.keybd_event(key, 0, 0, 0)
finally:
    for key in reversed(keys):
        user32.keybd_event(key, 0, 2, 0)
`, JSON.stringify(modifiers), String(key)], { timeout: 5000 });
}

app.whenReady().then(async () => {
    session.defaultSession.protocol.handle('https', request => {
        const pathname = new URL(request.url).pathname;
        const json = pathname === '/api/v1/auth/login'
            ? { authToken: 'fixture-token', config: { branding: 'PandoraPlus' } }
            : pathname === '/api/v1/station/getStations' ? { stations: [] } : {};
        return new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } });
    });
    const config = require('../config');
    config.setCredentials('fixture@example.invalid', 'fixture-password');
    require('../main');
    await waitFor(() => BrowserWindow.getAllWindows().length, 'main window');
    const win = BrowserWindow.getAllWindows()[0];
    const run = script => win.webContents.executeJavaScript(script, true);
    await waitFor(async () => !win.webContents.isLoading() && await run('AppState.isLoggedIn'), 'fixture sign-in');
    win.focus(); win.webContents.focus();
    await waitFor(() => win.isFocused(), 'main window keyboard focus');
    await run("renderPage('settings'); window.shortcutActions = []; window.api.shortcuts.onAction(action => window.shortcutActions.push(action))");
    await waitFor(() => run("!document.querySelector('[data-record-shortcut]').disabled"), 'shortcut settings');
    for (const action of ['toggle', 'next', 'prev']) {
        assert.match(await run(`document.querySelector('[data-default-shortcut="${action}"]').textContent`), /Media.*Default/);
    }
    assert.equal(await run("document.getElementById('shortcut-background').checked"), true);
    let loads = 0;
    win.webContents.on('did-finish-load', () => { loads++; });
    await run("document.querySelector('[data-record-shortcut=thumbUp]').click()");
    await waitFor(() => run("shortcutSettings.recording === 'thumbUp'"), 'recording starts');
    pressKey(0x4B);
    await waitFor(() => run("document.querySelector('[data-shortcut-recording=thumbUp]').textContent.includes('function key')"),
        'an invalid single key shows visible guidance');
    pressKey(0x52, [0x11, 0x10]); // Ctrl+Shift+R also reloads Electron windows.
    await waitFor(() => run("shortcutSettings.bindings.thumbUp === 'Ctrl+Shift+R'"), 'Windows key release saves the shortcut');
    assert.equal(loads, 0, 'Recording a reload chord must keep the Settings page open');
    assert.equal(await run('window.shortcutActions.length'), 0, 'The recording press must not run a playback command');
    assert.equal(await run("!!document.querySelector('.error-toast')"), false, 'Releasing modifiers after saving is harmless');
    assert.equal(globalShortcut.isRegistered('Ctrl+Shift+R'), true);

    const otherWindow = new BrowserWindow({ width: 320, height: 240 });
    await otherWindow.loadURL('about:blank');
    otherWindow.focus();
    await waitFor(() => otherWindow.isFocused() && !win.isFocused(), 'another app window has focus');
    pressKey(0x52, [0x11, 0x10]);
    await waitFor(() => run('window.shortcutActions.length === 1'), 'Windows background shortcut');
    assert.equal(otherWindow.isFocused(), true);
    otherWindow.destroy();
    win.focus(); win.webContents.focus();
    await run("document.getElementById('shortcut-background').click()");
    await waitFor(() => run('shortcutSettings.background === false'), 'focused shortcut scope');
    assert.equal(globalShortcut.isRegistered('Ctrl+Shift+R'), false);
    pressKey(0x52, [0x11, 0x10]);
    await waitFor(() => run('window.shortcutActions.length === 2'), 'Windows focused shortcut');
    assert.equal(loads, 0);
    await run("document.querySelector('[data-clear-shortcut=thumbUp]').click()");
    await waitFor(() => run('!shortcutSettings.bindings.thumbUp'), 'clearing a custom shortcut');
    assert.match(await run("document.querySelector('[data-default-shortcut=toggle]').textContent"), /Media Play\/Pause.*Default/);
    const saved = config.getKeyboardShortcuts();
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.reload(); await loaded;
    await waitFor(() => run('AppState.isLoggedIn'), 'reload sign-in');
    assert.deepEqual(await run('window.api.shortcuts.get().then(({background, bindings}) => ({background, bindings}))'), saved);
    console.log('Windows native shortcuts passed: media defaults, recording feedback, key release, background/focused input, clearing and reload.');
    clearTimeout(deadline);
    app.quit();
}).catch(error => {
    clearTimeout(deadline);
    console.error(error);
    app.exit(1);
});
