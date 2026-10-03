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

const HOUR = 60 * 60 * 1000;
function scheduledSetup(t, options = {}) {
    let clock = 1000;
    const timers = new Set();
    const notices = [];
    const s = setup({ ...options, now: () => clock, onNotice: notice => notices.push(notice),
        setTimer: (callback, delay) => {
            const timer = { callback, delay, at: clock + delay, unreferenced: false,
                unref() { this.unreferenced = true; } };
            timers.add(timer);
            return timer;
        },
        clearTimer: timer => timers.delete(timer)
    });
    t.after(() => s.checker.stop());
    return { ...s, timers, notices, now: () => clock, setTime: time => { clock = time; },
        fireNext: async () => {
            const timer = [...timers].sort((a, b) => a.at - b.at)[0];
            assert.ok(timer, 'A check is scheduled');
            clock = Math.max(clock, timer.at);
            timers.delete(timer);
            timer.callback();
            await s.checker.check();
        }
    };
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

test('daily checks use elapsed time, coalesce wake/focus/reload calls and rearm after an early wake', async t => {
    const s = scheduledSetup(t);
    await s.checker.start();
    assert.equal(s.requests.length, 1);
    assert.equal(s.timers.size, 1);
    assert.equal([...s.timers][0].delay, 24 * HOUR);
    assert.equal([...s.timers][0].unreferenced, true);
    s.setTime(1000 + 2 * HOUR);
    await s.checker.check();
    assert.equal(s.requests.length, 1);
    assert.equal([...s.timers][0].delay, 22 * HOUR);
    // Resume after 22 hours asleep, without running the original timer.
    s.setTime(1000 + 24 * HOUR);
    await Promise.all([s.checker.check(), s.checker.check(), s.checker.check()]);
    assert.equal(s.requests.length, 2);
    assert.equal(s.timers.size, 1);
    assert.equal([...s.timers][0].delay, 24 * HOUR);
});

test('the daily timer discovers a newly published release without navigation or playback', async t => {
    let tag = 'v1.1.3';
    let requests = 0;
    const s = scheduledSetup(t, { fetch: async () => { requests++; return { ok: true, json: async () => release({ tag_name: tag }) }; } });
    await s.checker.start();
    assert.equal(s.checker.notice, null);
    tag = 'v1.2.0';
    await s.fireNext();
    assert.equal(requests, 2);
    assert.deepEqual(s.notices, [{ version: '1.2.0', currentVersion: '1.1.3' }]);
});

test('failed checks retry after 15, 30 and then 60 minutes, returning to daily checks on success', async t => {
    let fail = true;
    let requests = 0;
    const s = scheduledSetup(t, { fetch: async () => {
        requests++;
        if (fail) throw new Error('Offline');
        return { ok: true, json: async () => release() };
    } });
    await s.checker.start();
    for (const delay of [HOUR / 4, HOUR / 2, HOUR, HOUR]) {
        assert.equal([...s.timers][0].delay, delay);
        const before = requests;
        await s.checker.check();
        assert.equal(requests, before, 'Refreshes cannot bypass the retry wait');
        await s.fireNext();
    }
    fail = false;
    await s.fireNext();
    assert.equal(s.checker.notice.version, '1.2.0');
    assert.equal([...s.timers][0].delay, 24 * HOUR);
    assert.equal(s.checker.failures, 0);
});

test('rate-limit retries honor Retry-After seconds, HTTP dates and the GitHub reset time', async t => {
    for (const [status, values, delay] of [
        [429, { 'retry-after': '7200' }, 2 * HOUR],
        [403, { 'retry-after': new Date(1000 + 2 * HOUR).toUTCString() }, 2 * HOUR],
        [403, { 'x-ratelimit-reset': String((1000 + 3 * HOUR) / 1000), 'retry-after': '7200' }, 3 * HOUR],
        [429, { 'retry-after': 'invalid', 'x-ratelimit-reset': 'invalid' }, HOUR / 4]
    ]) {
        const s = scheduledSetup(t, { fetch: async () => ({ ok: false, status, headers: new Headers(values) }) });
        await s.checker.start();
        assert.equal([...s.timers][0].delay, delay);
        s.checker.stop();
    }
});

test('failed rechecks retain a verified notice, and valid current releases clear it', async t => {
    let mode = 'new';
    const s = scheduledSetup(t, { fetch: async () => {
        if (mode === 'offline') throw new Error('Offline');
        return { ok: true, json: async () => release({ tag_name: mode === 'current' ? 'v1.1.3' : 'v1.2.0' }) };
    } });
    await s.checker.start();
    mode = 'offline';
    await s.fireNext();
    assert.equal(s.checker.notice.version, '1.2.0');
    assert.equal(s.notices.length, 1);
    mode = 'current';
    await s.fireNext();
    assert.equal(s.checker.notice, null);
    assert.equal(s.notices.at(-1), null);
});

test('Later remains snoozed through daily checks and reminds after 24 hours without an extra request', async t => {
    const s = scheduledSetup(t);
    await s.checker.start();
    s.setTime(1000 + 2 * HOUR);
    assert.equal(s.checker.dismiss('1.2.0'), true);
    assert.equal(s.checker.notice, null);
    await s.fireNext(); // Daily check at hour 24, still inside the snooze.
    assert.equal(s.requests.length, 2);
    assert.equal(s.checker.notice, null);
    assert.equal([...s.timers][0].delay, 2 * HOUR);
    await s.fireNext(); // Snooze ends at hour 26.
    assert.equal(s.requests.length, 2, 'Known updates can be reminded locally');
    assert.equal(s.checker.notice.version, '1.2.0');
    assert.equal([...s.timers][0].delay, 22 * HOUR);
});

test('a different release can be announced while an older version is snoozed', async t => {
    let tag = 'v1.2.0';
    const s = scheduledSetup(t, { fetch: async () => ({ ok: true, json: async () => release({ tag_name: tag }) }) });
    await s.checker.start();
    s.setTime(1000 + 2 * HOUR);
    s.checker.dismiss('1.2.0');
    tag = 'v1.3.0';
    await s.fireNext();
    assert.equal(s.checker.notice.version, '1.3.0');
    assert.equal(s.checker.dismiss('1.2.0'), false, 'Old responses cannot dismiss the new release');
});

test('quitting cancels the schedule and an in-flight check without publishing a late notice', async t => {
    let finish;
    let signal;
    let requests = 0;
    const s = scheduledSetup(t, { fetch: (url, init) => {
        if (requests++ === 0) return Promise.resolve({ ok: true, json: async () => release() });
        signal = init.signal;
        return new Promise(resolve => { finish = resolve; });
    } });
    await s.checker.start();
    s.checker.dismiss('1.2.0');
    assert.equal(s.timers.size, 1);
    s.setTime(1000 + 24 * HOUR);
    const pending = s.checker.check();
    s.checker.stop();
    assert.equal(signal.aborted, true);
    finish({ ok: true, json: async () => release() });
    await pending;
    assert.equal(s.timers.size, 0);
    assert.deepEqual(s.notices, [{ version: '1.2.0', currentVersion: '1.1.3' }, null],
        'An expiring snooze must not publish a notice after quitting');
    assert.equal(await s.checker.check(), null);
});
