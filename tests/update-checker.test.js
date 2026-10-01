const test = require('node:test');
const assert = require('node:assert/strict');
const { UpdateChecker, RELEASE_API, parseVersion, isNewerRelease } = require('../update-checker');

const release = (extra = {}) => ({
    tag_name: 'v1.2.0', draft: false, prerelease: false,
    assets: [{ name: 'Panedora-1.2.0.AppImage' }], ...extra
});
function setup(options = {}) {
    const requests = [];
    let saved = null;
    const checker = new UpdateChecker({
        version: '1.1.3', platform: 'linux', arch: 'x64', now: () => 1000,
        fetch: async (url, init) => {
            requests.push({ url, init });
            return { ok: true, json: async () => release() };
        },
        getSnooze: () => saved, setSnooze: value => { saved = value; }, ...options
    });
    return { checker, requests, saved: () => saved };
}

test('release comparison uses numeric stable versions and handles tagged and prerelease installs', () => {
    for (const [latest, current, expected] of [
        ['v1.10.0', '1.9.9', true], ['V2.0.0', '1.99.99', true],
        ['1.1.3', '1.1.3', false], ['1.1.2', '1.1.3', false],
        ['1.1.3+build2', '1.1.3+build1', false],
        ['1.1.3', '1.1.3-beta.1', true], ['1.1.4-beta.1', '1.1.3', false]
    ]) assert.equal(isNewerRelease(parseVersion(latest), parseVersion(current)), expected, `${latest} vs ${current}`);
    for (const value of [null, 3, '', '1.2', '1.2.3.4', '01.2.3', '1.2.3-beta.01', '1.2.3\n',
        '9007199254740992.0.0', '<script>1.2.3</script>']) assert.equal(parseVersion(value), null);
});

test('concurrent checks share one public, credential-free request and return only version information', async () => {
    const s = setup();
    const notices = await Promise.all([s.checker.check(), s.checker.check()]);
    assert.deepEqual(notices, Array(2).fill({ version: '1.2.0', currentVersion: '1.1.3' }));
    assert.equal(s.requests.length, 1);
    const request = s.requests[0];
    assert.equal(request.url, RELEASE_API);
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.redirect, 'error');
    assert.deepEqual(request.init.headers, { Accept: 'application/vnd.github+json', 'User-Agent': 'Panedora update check' });
    assert.equal(request.init.body, undefined);
    await s.checker.check();
    assert.equal(s.requests.length, 1);
});

test('unpublished, older, malformed and incompatible releases do not prompt', async () => {
    for (const data of [
        null, {}, release({ draft: true }), release({ prerelease: true }),
        release({ tag_name: 'v1.2.0-beta.1' }), release({ tag_name: 'v1.1.3' }),
        release({ tag_name: 'v1.0.0' }), release({ tag_name: 'not-a-version' }),
        release({ assets: [] }), release({ assets: [{ name: 'Panedora.exe' }] }),
        release({ assets: [{ name: 'Panedora-arm64.AppImage' }] }),
        release({ assets: [{ name: null }] })
    ]) {
        const s = setup({ fetch: async () => ({ ok: true, json: async () => data }) });
        assert.equal(await s.checker.check(), null, JSON.stringify(data));
    }
    const invalid = setup({ version: 'dev' });
    assert.equal(await invalid.checker.check(), null);
    assert.equal(invalid.requests.length, 0);
});

test('compatible installers are required for Windows, macOS and Linux', async () => {
    for (const [platform, arch, filename, expected] of [
        ['win32', 'x64', 'Panedora-Setup-1.2.0.exe', true],
        ['darwin', 'arm64', 'Panedora-1.2.0-arm64.dmg', true],
        ['darwin', 'x64', 'Panedora-1.2.0-arm64.dmg', false],
        ['darwin', 'arm64', 'Panedora-1.2.0-x64.dmg', false],
        ['linux', 'x64', 'Panedora-1.2.0-amd64.AppImage', true],
        ['linux', 'arm64', 'Panedora-1.2.0-amd64.AppImage', false]
    ]) {
        const s = setup({ platform, arch, fetch: async () => ({ ok: true,
            json: async () => release({ assets: [{ name: filename }] }) }) });
        assert.equal(!!await s.checker.check(), expected, filename + ' on ' + arch);
    }
});

test('offline, rate-limited, malformed and timed-out checks fail quietly', async () => {
    for (const fetch of [
        async () => { throw new Error('Offline'); },
        async () => ({ ok: false, json: () => { throw new Error('Must not parse failed response'); } }),
        async () => ({ ok: true, json: async () => { throw new SyntaxError('Not JSON'); } }),
        (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }))
    ]) assert.equal(await setup({ fetch, timeoutMs: 5 }).checker.check(), null);
});

test('Later snoozes only the verified release for 24 hours across app launches', async () => {
    const s = setup();
    await s.checker.check();
    assert.equal(s.checker.dismiss('unverified'), false);
    assert.equal(s.saved(), null);
    assert.equal(s.checker.dismiss('1.2.0'), true);
    assert.deepEqual(s.saved(), { version: '1.2.0', until: 1000 + 86400000 });
    assert.equal(await s.checker.check(), null, 'Renderer reload cannot reopen a dismissed notice');
    assert.equal(s.checker.dismiss('1.2.0'), false);
    assert.equal(await setup({ getSnooze: s.saved }).checker.check(), null);
    assert.ok(await setup({ getSnooze: s.saved, now: () => 1000 + 86400000 }).checker.check());
    const newer = setup({ getSnooze: s.saved, fetch: async () => ({ ok: true,
        json: async () => release({ tag_name: 'v1.3.0' }) }) });
    assert.equal((await newer.checker.check()).version, '1.3.0');
});
