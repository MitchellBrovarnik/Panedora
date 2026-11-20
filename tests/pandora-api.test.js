const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule, challenge } = require('./test-helpers');

function setup(responses) {
    const state = { authToken: 'expired-token', credentials: { email: 'test@example.invalid', password: 'test-password' } };
    const cookies = [];
    const calls = [];
    const electron = {
        session: { defaultSession: {
            getUserAgent: () => 'Panedora actual browser agent',
            cookies: {
                get: async () => cookies.filter(c => c.name === 'csrftoken'),
                set: async cookie => { cookies.push(cookie); }
            }
        } },
        net: { fetch: async (url, options) => {
            calls.push({ url, ...options });
            const fixture = responses.shift();
            const next = typeof fixture === 'function' ? await fixture() : fixture;
            assert.ok(next, 'Unexpected extra request');
            if (next instanceof Error) throw next;
            return { ok: next.status === 200, status: next.status, text: async () => JSON.stringify(next.body) };
        } }
    };
    const config = {
        getAuthToken: () => state.authToken,
        getPlaybackDeviceId: () => 'test-device',
        getCsrfToken: () => state.csrfToken,
        getCredentials: () => state.credentials,
        setAuthToken: value => { state.authToken = value; },
        setCsrfToken: value => { state.csrfToken = value; },
        setCredentials: (email, password) => { state.credentials = { email, password }; },
        setListenerId: value => { state.listenerId = value; },
        clearAll: () => { state.authToken = null; state.credentials = null; }
    };
    const API = loadModule(path.join(__dirname, '..', 'pandora-api.js'), { electron, './config': config });
    return { api: new API(), state, cookies, calls, electron };
}

const blocked = () => ({ status: 403, body: { ...challenge } });
const paid = () => ({ status: 200, body: { authToken: 'new-token', listenerId: 'listener', config: { branding: 'PandoraPlus' } } });
const premium = (token = 'premium-token') => ({ status: 200, body: { authToken: token, config: { branding: 'PandoraPremium', flags: ['onDemand'] } } });

test('artwork ignores missing URLs and retains valid resolutions in descending size order', () => {
    const API = setup([]).api.constructor;
    const art = [null, { size: 1080 }, { size: 900, url: ' ' }, { size: '100', url: 'https://fixture.invalid/small.jpg' },
        { size: 500, url: 'https://fixture.invalid/large.jpg' }, { size: 50, url: 'https://fixture.invalid/small.jpg' }];
    assert.equal(API.getHighResArt(art), 'https://fixture.invalid/large.jpg');
    assert.deepEqual(Array.from(API.getArtUrls(art)), ['https://fixture.invalid/large.jpg', 'https://fixture.invalid/small.jpg']);
    assert.equal(API.getHighResArt(null), null);
    assert.equal(art[0], null, 'The original API array is not reordered');
});

function modeResponse(currentModeId = 0) {
    return {
        interactiveRadioAvailable: true,
        currentModeId,
        availableModes: [
            { modeId: 0, modeName: 'My Station', isModeAvailable: true },
            { modeId: 1091989, modeName: 'Energy Boost', modeDescription: 'More energy.', isModeAvailable: true },
            { modeId: 5, modeName: 'Artist Only', isModeAvailable: false, isPremiumOnly: true }
        ]
    };
}

test('repeated Artist Only changes keep the active listening session', async () => {
    const { api, electron, calls } = setup([]);
    let logins = 0;
    let owner = null;
    let mode = 0;
    electron.net.fetch = async (url, options) => {
        calls.push({ url, ...options });
        const endpoint = new URL(url).pathname;
        const body = JSON.parse(options.body);
        const token = options.headers['X-AuthToken'];
        let status = 200;
        let response = {};
        if (endpoint.endsWith('/auth/login')) {
            response = { authToken: `premium-session-${++logins}`, config: { branding: 'PandoraPremium', flags: ['onDemand'] } };
        } else if (endpoint.endsWith('/playbackResumed') && !owner) owner = token;
        else if (token !== owner) {
            status = 429;
            response = { errorString: 'STREAM_VIOLATION' };
        } else if (endpoint.endsWith('/getAvailableModesSimple') || endpoint.endsWith('/setAndGetAvailableModes')) {
            if (endpoint.endsWith('/setAndGetAvailableModes')) mode = body.modeId;
            response = modeResponse(mode);
            response.availableModes.find(item => item.modeId === 5).isModeAvailable = true;
        } else if (endpoint.endsWith('/getFragment')) response = { tracks: [] };
        else assert.fail(`Unexpected endpoint: ${endpoint}`);
        return { ok: status === 200, status, text: async () => JSON.stringify(response) };
    };
    assert.equal((await api.login('test@example.invalid', 'test-password')).success, true);
    assert.equal((await api.playbackResumed(false)).success, true);
    for (const modeId of [5, 1091989, 5, 0, 5]) {
        const changed = await api.setStationMode('station-1', modeId);
        assert.equal(changed.success, true, `Mode ${modeId} must reuse the session that owns playback`);
        assert.equal(changed.streamConflict, undefined);
        assert.equal((await api.getPlaylist('station-1', false)).streamConflict, undefined);
        assert.equal(api.authToken, owner);
    }
    assert.equal(logins, 1, 'Changing modes must not sign in again');
    assert.equal(calls.some(call => JSON.parse(call.body).forceActive === true), false);
});

test('station modes use the interactive-radio endpoint and normalize actual IDs and restrictions', async () => {
    for (const nested of [false, true]) {
        const data = modeResponse('0');
        data.availableModes.push({ modeId: null, modeName: 'Invalid' }, { modeId: 0, modeName: 'Duplicate' });
        const { api, calls } = setup([{ status: 200, body: nested ? { result: data, stat: 'ok' } : data }]);
        const result = await api.getStationModes('station-1');
        assert.equal(result.success, true);
        assert.equal(result.currentModeId, 0);
        assert.equal(result.modes.length, 3);
        assert.equal(result.modes[1].id, 1091989);
        assert.equal(result.modes[2].available, false);
        assert.equal(result.modes[2].premiumOnly, true);
        assert.equal(calls[0].url, 'https://www.pandora.com/api/v1/interactiveradio/getAvailableModesSimple');
        assert.deepEqual(JSON.parse(calls[0].body), { stationId: 'station-1' });
        assert.equal(calls[0].headers['X-AuthToken'], 'expired-token');
    }
});

test('setting a mode sends its numeric API ID and requires the returned mode to match', async () => {
    for (const currentModeId of [1091989, '1091989', 0, null]) {
        const { api, calls } = setup([
            { status: 200, body: modeResponse() },
            { status: 200, body: modeResponse(currentModeId) }
        ]);
        const result = await api.setStationMode('station-1', 1091989);
        assert.equal(result.success, Number(currentModeId) === 1091989);
        assert.equal(calls[1].url, 'https://www.pandora.com/api/v1/interactiveradio/setAndGetAvailableModes');
        assert.deepEqual(JSON.parse(calls[1].body), { stationId: 'station-1', modeId: 1091989 });
    }
});

test('a station with no modes is distinguished from a malformed or failed modes response', async () => {
    const { api } = setup([
        { status: 200, body: { interactiveRadioAvailable: false } },
        { status: 200, body: {} },
        { status: 200, body: { stat: 'fail', result: modeResponse() } }
    ]);
    assert.equal((await api.getStationModes('shuffle')).available, false);
    assert.equal((await api.getStationModes('station-1')).success, false);
    assert.equal((await api.getStationModes('station-1')).success, false);
});

test('invalid IDs are rejected without requests and mode conflicts never force takeover', async () => {
    const { api, calls } = setup([{ status: 429, body: { errorString: 'STREAM_VIOLATION' } }]);
    for (const id of [null, -1, '5', NaN, 1.5]) {
        assert.equal((await api.setStationMode('station-1', id)).success, false);
    }
    assert.equal(calls.length, 0);
    const result = await api.setStationMode('station-1', 1091989);
    assert.equal(result.streamConflict, true);
    assert.equal(calls.length, 1);
});

test('Artist Only is hidden for Plus, unknown and stored-token accounts even when offered by the station', async () => {
    for (const login of [null, paid(), {
        status: 200, body: { authToken: 'plus-token', config: {
            branding: 'PandoraPlus', flags: ['onDemand', 'adFreeSkip', 'highQualityStreamingAvailable']
        }, highQualityStreamingEnabled: true }
    }, { status: 200, body: { authToken: 'unknown-token', config: { branding: 'UnknownPaidPlan' } } }]) {
        const available = modeResponse();
        available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
        const { api, calls } = setup([
            ...(login ? [login] : []),
            { status: 200, body: available },
            { status: 200, body: available }
        ]);
        if (login) assert.equal((await api.login('test@example.invalid', 'test-password')).success, true);
        const modes = await api.getStationModes('station-1');
        assert.equal(modes.modes.find(mode => mode.id === 5).available, false);
        assert.equal(modes.modes.find(mode => mode.id === 1091989).available, true);
        assert.equal((await api.setStationMode('station-1', 5)).success, false);
        assert.equal(calls.some(call => call.url.endsWith('/setAndGetAvailableModes')), false);
    }
});

test('verified Premium still requires an eligible station and does not depend on the premium-only flag', async () => {
    for (const eligible of [true, false]) {
        const available = modeResponse();
        const artistOnly = available.availableModes.find(mode => mode.modeId === 5);
        artistOnly.isModeAvailable = eligible;
        delete artistOnly.isPremiumOnly;
        const { api } = setup([premium(), { status: 200, body: available }]);
        await api.login('test@example.invalid', 'test-password');
        const result = await api.getStationModes('station-1');
        assert.equal(result.modes.find(mode => mode.id === 5).available, eligible);
        assert.equal(result.modes.find(mode => mode.id === 5).premiumOnly, true);
    }
});

test('Premium-only selections reuse the verified login and require Pandora to confirm the mode', async () => {
    const available = modeResponse();
    available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
    const confirmed = { ...available, currentModeId: 5 };
    const { api, calls } = setup([
        premium(), { status: 200, body: available }, { status: 200, body: confirmed }
    ]);
    await api.login('test@example.invalid', 'test-password');
    assert.equal((await api.setStationMode('station-1', 5)).success, true);
    assert.deepEqual(calls.slice(1).map(call => new URL(call.url).pathname), [
        '/api/v1/interactiveradio/getAvailableModesSimple',
        '/api/v1/interactiveradio/setAndGetAvailableModes'
    ]);
    assert.equal(calls[2].headers['X-AuthToken'], 'premium-token');
});

test('verified Premium mode changes do not require another copy of the saved password', async () => {
    const available = modeResponse();
    available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
    const { api, state, calls } = setup([premium(), { status: 200, body: available }, { status: 200, body: { ...available, currentModeId: 5 } }]);
    await api.login('test@example.invalid', 'test-password');
    state.credentials = null;
    assert.equal((await api.setStationMode('station-1', 5)).success, true);
    assert.equal(calls.filter(call => call.url.endsWith('/auth/login')).length, 1);
});

test('failed or unavailable renewal cannot retry an expired Premium mode request', async () => {
    const available = modeResponse();
    available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
    for (const nextLogin of [{ status: 401, body: { message: 'Session expired' } }, null]) {
        const { api, state, calls } = setup([
            premium(), { status: 200, body: available }, { status: 401, body: { errorCode: 1000 } }, ...(nextLogin ? [nextLogin] : [])
        ]);
        await api.login('test@example.invalid', 'test-password');
        if (!nextLogin) state.credentials = null;
        api.onSessionExpired = async options => state.credentials
            ? (await api.login(state.credentials.email, state.credentials.password, { ...options, refreshSession: true })).success
            : false;
        assert.equal((await api.setStationMode('station-1', 5)).success, false);
        assert.equal(calls.filter(call => call.url.endsWith('/setAndGetAvailableModes')).length, 1);
        assert.equal(calls.filter(call => call.url.endsWith('/auth/login')).length, nextLogin ? 2 : 1);
    }
});

test('unoffered, unavailable and unconfirmed modes cannot succeed through a direct API call', async () => {
    for (const id of [5, 987654]) {
        const { api, calls } = setup([{ status: 200, body: modeResponse() }]);
        assert.equal((await api.setStationMode('station-1', id)).success, false);
        assert.equal(calls.length, 1);
    }
    for (const stationUnavailable of [false, true]) {
        const revoked = modeResponse(1091989);
        if (stationUnavailable) revoked.interactiveRadioAvailable = false;
        else revoked.availableModes.find(mode => mode.modeId === 1091989).isModeAvailable = false;
        const { api } = setup([{ status: 200, body: modeResponse() }, { status: 200, body: revoked }]);
        assert.equal((await api.setStationMode('station-1', 1091989)).success, false);
    }
});

test('Premium proof is cleared when logging out or restoring a saved token', async () => {
    const { api } = setup([premium(), premium()]);
    await api.login('test@example.invalid', 'test-password');
    assert.equal(api.hasPremiumAccess(), true);
    api.restoreAuth();
    assert.equal(api.hasPremiumAccess(), false);
    await api.login('test@example.invalid', 'test-password');
    assert.equal(api.hasPremiumAccess(), true);
    api.logout();
    assert.equal(api.hasPremiumAccess(), false);
});

test('an expired Premium mode request cannot retry after reauthentication downgrades the account', async () => {
    const available = modeResponse();
    available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
    const { api, calls } = setup([
        premium(), { status: 200, body: available },
        { status: 401, body: { errorCode: 1000 } }, paid(),
        { status: 200, body: { ...available, currentModeId: 5 } }
    ]);
    await api.login('test@example.invalid', 'test-password');
    api.onSessionExpired = async options => (await api.login('test@example.invalid', 'test-password', { ...options, refreshSession: true })).success;
    const result = await api.setStationMode('station-1', 5);
    assert.equal(result.success, false);
    assert.equal(result.cancelled, false, 'The Premium gate, not session cancellation, must stop the retry');
    assert.equal(api.isAuthenticated(), true);
    assert.equal(api.hasPremiumAccess(), false);
    assert.equal(calls.filter(call => call.url.endsWith('/setAndGetAvailableModes')).length, 1);
});

test('an eligible Premium mode still retries successfully after session renewal or CAPTCHA', async () => {
    for (const verification of [false, true]) {
        const available = modeResponse();
        available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
        const { api, calls } = setup([
            premium(), { status: 200, body: available },
            verification ? blocked() : { status: 401, body: { errorCode: 1000 } },
            ...(verification ? [] : [premium('renewed-premium-token')]),
            { status: 200, body: { ...available, currentModeId: 5 } }
        ]);
        await api.login('test@example.invalid', 'test-password');
        api.onSessionExpired = async options => (await api.login('test@example.invalid', 'test-password', { ...options, refreshSession: true })).success;
        api.onVerificationRequired = async () => true;
        assert.equal((await api.setStationMode('station-1', 5)).success, true);
        assert.equal(calls.filter(call => call.url.endsWith('/setAndGetAvailableModes')).length, 2);
        assert.equal(api.hasPremiumAccess(), true);
        assert.equal(calls.at(-1).headers['X-AuthToken'], verification ? 'premium-token' : 'renewed-premium-token');
    }
});

test('logging out during an expired Premium request cannot restore credentials or retry the setter', async () => {
    const available = modeResponse();
    available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
    let completeLogin;
    let loginStarted;
    const checking = new Promise(resolve => { loginStarted = resolve; });
    const { api, state, calls } = setup([
        premium(), { status: 200, body: available },
        { status: 401, body: { errorCode: 1000 } },
        () => { loginStarted(); return new Promise(resolve => { completeLogin = resolve; }); },
        { status: 200, body: { ...available, currentModeId: 5 } }
    ]);
    await api.login('test@example.invalid', 'test-password');
    api.onSessionExpired = async options => (await api.login('test@example.invalid', 'test-password', { ...options, refreshSession: true })).success;
    const change = api.setStationMode('station-1', 5);
    await checking;
    api.logout();
    completeLogin(premium());
    await change;
    assert.equal(api.isAuthenticated(), false);
    assert.equal(api.hasPremiumAccess(), false);
    assert.equal(state.credentials, null);
    assert.equal(calls.filter(call => call.url.endsWith('/setAndGetAvailableModes')).length, 1);
});

test('a cancelled station change stops after preflight, session renewal or CAPTCHA', async () => {
    for (const stage of ['preflight', 'renewal', 'captcha']) {
        const available = modeResponse();
        available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
        let complete;
        let started;
        const waiting = new Promise(resolve => { started = resolve; });
        const deferred = () => { started(); return new Promise(resolve => { complete = resolve; }); };
        const { api, calls } = setup([
            premium(),
            stage === 'preflight' ? deferred : { status: 200, body: available },
            stage === 'renewal' ? { status: 401, body: { errorCode: 1000 } } : blocked(),
            ...(stage === 'renewal' ? [deferred] : [])
        ]);
        await api.login('test@example.invalid', 'test-password');
        api.onSessionExpired = async options => (await api.login('test@example.invalid', 'test-password', { ...options, refreshSession: true })).success;
        api.onVerificationRequired = deferred;
        let current = true;
        const changing = api.setStationMode('station-1', 5, { isCurrent: () => current });
        await waiting;
        current = false;
        complete(stage === 'preflight' ? { status: 200, body: available } : stage === 'renewal' ? premium() : true);
        const result = await changing;
        assert.equal(result.success, false);
        assert.equal(result.cancelled, true);
        assert.equal(calls.filter(call => call.url.endsWith('/setAndGetAvailableModes')).length, stage === 'preflight' ? 0 : 1);
        assert.equal(api.hasPremiumAccess(), true, 'Station cancellation must not erase the existing account proof');
    }
});

test('eligibility and cancellation are checked again after asynchronous cookie access', async () => {
    for (const cancel of [false, true]) {
        const available = modeResponse();
        available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
        const { api, calls, electron, cookies } = setup([premium(), { status: 200, body: available }]);
        await api.login('test@example.invalid', 'test-password');
        let finishCookieRead;
        let started;
        const waiting = new Promise(resolve => { started = resolve; });
        let reads = 0;
        electron.session.defaultSession.cookies.get = async () => {
            if (++reads === 2) {
                started();
                return new Promise(resolve => { finishCookieRead = resolve; });
            }
            return cookies;
        };
        let current = true;
        const changing = api.setStationMode('station-1', 5, { isCurrent: () => current });
        await waiting;
        if (cancel) current = false;
        else api.premiumAuthToken = null;
        finishCookieRead(cookies);
        assert.equal((await changing).success, false);
        assert.equal(calls.some(call => call.url.endsWith('/setAndGetAvailableModes')), false);
    }
});

test('a late login or subscription check cannot overwrite logout, restore or a newer account', async () => {
    for (const action of ['logout', 'restore', 'new-login', 'verify-logout']) {
        let complete;
        let started;
        const waiting = new Promise(resolve => { started = resolve; });
        const { api, state } = setup([
            () => { started(); return new Promise(resolve => { complete = resolve; }); }, paid()
        ]);
        const oldLogin = action === 'verify-logout' ? api.verifySubscription() : api.login('old@example.invalid', 'old-password');
        await waiting;
        if (action === 'restore') api.restoreAuth();
        else if (action === 'new-login') await api.login('new@example.invalid', 'new-password');
        else api.logout();
        const expected = { ...state };
        complete(premium());
        const result = await oldLogin;
        if (action === 'verify-logout') assert.equal(result, false);
        else assert.equal(result.cancelled, true);
        assert.deepEqual(state, expected);
        assert.equal(api.hasPremiumAccess(), false);
        assert.equal(api.authToken, expected.authToken);
    }
});

test('a late expired request cannot reauthenticate a logged-out or replaced session', async () => {
    for (const replace of [false, true]) {
        let complete;
        let started;
        const waiting = new Promise(resolve => { started = resolve; });
        const { api, calls, state } = setup([
            () => { started(); return new Promise(resolve => { complete = resolve; }); }, paid()
        ]);
        api.onSessionExpired = () => assert.fail('A stale request must not start another login');
        const request = api.request('/v1/station/getStations');
        const rejection = assert.rejects(request, error => error.cancelled === true);
        await waiting;
        if (replace) await api.login('new@example.invalid', 'new-password');
        else api.logout();
        const expected = { ...state };
        complete({ status: 401, body: { errorCode: 1000 } });
        await rejection;
        assert.deepEqual(state, expected);
        assert.equal(calls.length, replace ? 2 : 1);
    }
});

test('blocked sign-in waits for verification and uses its cookies for one retry', async () => {
    const { api, state, cookies, calls } = setup([blocked(), paid()]);
    let prompts = 0;
    api.onVerificationRequired = async (error, url) => {
        prompts++;
        assert.equal(error.errorString, 's2s_high_score');
        assert.equal(url, 'https://www.pandora.com/api/v1/auth/login');
        cookies[0].value = 'browser-csrf';
        return true;
    };
    const result = await api.login('test@example.invalid', 'test-password');
    assert.equal(result.success, true);
    assert.equal(prompts, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers['X-CsrfToken'], 'browser-csrf');
    assert.equal(calls[1].headers['User-Agent'], 'Panedora actual browser agent');
    assert.equal(calls[1].credentials, 'include');
    assert.equal('X-AuthToken' in calls[1].headers, false);
    assert.equal(calls[1].body, calls[0].body);
    assert.equal(state.authToken, 'new-token');
    assert.equal(state.csrfToken, 'browser-csrf');
});

test('cancelled verification keeps saved credentials and sends no retry', async () => {
    const { api, state, calls } = setup([blocked()]);
    api.onVerificationRequired = async () => false;
    const credentials = state.credentials;
    const result = await api.login('test@example.invalid', 'test-password');
    assert.equal(result.success, false);
    assert.match(result.error, /cancelled/);
    assert.equal(state.credentials, credentials);
    assert.equal(calls.length, 1);
});

test('a repeated verification block stops without a prompt or request loop', async () => {
    const { api, calls } = setup([blocked(), blocked()]);
    let prompts = 0;
    api.onVerificationRequired = async () => { prompts++; return true; };
    const result = await api.login('test@example.invalid', 'test-password');
    assert.equal(result.success, false);
    assert.match(result.error, /still requiring browser verification/);
    assert.equal(prompts, 1);
    assert.equal(calls.length, 2);
});

test('verification does not skip the paid-account check', async () => {
    const { api, state } = setup([blocked(), { status: 200, body: { authToken: 'free-token', config: { branding: 'Pandora' } } }]);
    api.onVerificationRequired = async () => true;
    const result = await api.login('test@example.invalid', 'test-password');
    assert.equal(result.success, false);
    assert.match(result.error, /subscription/);
    assert.equal(state.authToken, 'expired-token');
});

test('credential rejection does not trigger CAPTCHA or automatic re-login', async () => {
    const { api, calls } = setup([{ status: 401, body: { message: 'Invalid credentials', errorCode: 1000 } }]);
    api.onVerificationRequired = () => assert.fail('Unexpected verification');
    api.onSessionExpired = () => assert.fail('Unexpected re-login');
    const result = await api.login('test@example.invalid', 'test-password');
    assert.equal(result.error, 'Invalid credentials');
    assert.equal(calls.length, 1);
});

test('expired playback request re-authenticates and retries with the new token', async () => {
    const { api, calls } = setup([{ status: 401, body: { errorCode: 1000 } }, { status: 200, body: { stations: [] } }]);
    let refreshes = 0;
    api.onSessionExpired = async () => { refreshes++; api.authToken = 'refreshed-token'; return true; };
    await api.request('/v1/station/getStations');
    assert.equal(refreshes, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers['X-AuthToken'], 'refreshed-token');
});

test('failure to load verification returns a useful error without another request', async () => {
    const { api, calls } = setup([blocked()]);
    api.onVerificationRequired = async () => { throw new Error('Page did not load'); };
    const result = await api.login('test@example.invalid', 'test-password');
    assert.match(result.error, /Could not open Pandora verification/);
    assert.equal(calls.length, 1);
});

test('verification can be followed by one expired-session refresh', async () => {
    const { api, calls } = setup([blocked(), { status: 401, body: { errorCode: 1000 } }, { status: 200, body: { stations: [] } }]);
    let prompts = 0;
    let refreshes = 0;
    api.onVerificationRequired = async () => { prompts++; return true; };
    api.onSessionExpired = async () => { refreshes++; api.authToken = 'refreshed-token'; return true; };
    await api.request('/v1/station/getStations');
    assert.equal(prompts, 1);
    assert.equal(refreshes, 1);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].headers['X-AuthToken'], 'refreshed-token');
});

test('an invalid refreshed session does not create a re-login loop', async () => {
    const rejected = { status: 401, body: { errorCode: 1000 } };
    const { api, calls } = setup([rejected, rejected]);
    let refreshes = 0;
    api.onSessionExpired = async () => { refreshes++; return true; };
    await assert.rejects(api.request('/v1/station/getStations'), error => error.status === 401);
    assert.equal(refreshes, 1);
    assert.equal(calls.length, 2);
});

test('a successful playlist response containing a stream violation is not retried automatically', async () => {
    const { api, calls } = setup([{ status: 200, body: { tracks: [{ trackType: 'SimStreamViolation' }] } }]);
    const result = await api.getPlaylist('station');
    assert.equal(result.streamConflict, true);
    assert.equal(result.tracks.length, 0);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/playlist/getFragment'));
});

test('HTTP 429 stream violations are distinguished from ordinary rate limits', async () => {
    const { api, calls } = setup([
        { status: 429, body: { errorString: 'STREAM_VIOLATION' } },
        { status: 429, body: { errorString: 'RATE_LIMITED' } }
    ]);
    assert.equal((await api.getPlaylist('station')).streamConflict, true);
    assert.equal((await api.getPlaylist('station')).streamConflict, undefined);
    assert.equal(calls.length, 2);
});

test('normal resumption does not request takeover; explicit takeover uses the resume endpoint', async () => {
    const { api, calls } = setup([{ status: 200, body: {} }, { status: 200, body: {} }]);
    assert.equal((await api.playbackResumed()).success, true);
    assert.equal(JSON.parse(calls[0].body).forceActive, false);
    assert.equal((await api.playbackResumed(true)).success, true);
    assert.equal(JSON.parse(calls[1].body).forceActive, true);
    assert.ok(calls[1].url.endsWith('/station/playbackResumed'));
});

test('a rejected takeover stops after one request', async () => {
    const { api, calls } = setup([{ status: 429, body: { errorString: 'STREAM_VIOLATION' } }]);
    const result = await api.playbackResumed(true);
    assert.equal(result.success, false);
    assert.equal(result.streamConflict, true);
    assert.equal(calls.length, 1);
});

const catalogOK = body => ({ status: 200, body });
function catalogReply(changes = {}) {
    return { source: { pandoraId: 'AL:42' }, item: { type: 'Track', pandoraId: 'TR:22', sourceId: 'AL:42',
        index: 2, audioUrl: 'http://fixture.invalid/approved.mp4', trackToken: 'recording-token',
        songName: 'Live recording', duration: 180, interactions: ['SKIP', 'SEEK'], ...changes } };
}

test('Premium search and artist pages use catalog IDs and preserve the returned order', async () => {
    const annotations = { 'TR:21': { name: 'Song', artistName: 'Artist' }, 'TR:22': { name: 'Song (live)' },
        'AL:42': { name: 'Record' }, 'AR:1': { name: 'Artist' } };
    const { api, calls } = setup([premium(), catalogOK({ results: ['TR:22', 'AL:42', 'AR:1', 'TR:21'], annotations }),
        catalogOK({ artistDetails: { topTracks: ['TR:21', 'TR:22'], topAlbums: ['AL:42'] }, annotations })]);
    await api.login('test', 'test');
    const search = await api.search('artist');
    assert.deepEqual(search.songs.map(s => s.id), ['TR:22', 'TR:21']);
    assert.equal(search.albums[0].id, 'AL:42');
    const artist = await api.catalog.artist(search.artists[0].id);
    assert.deepEqual(artist.songs.map(s => s.id), ['TR:21', 'TR:22']);
    assert.equal(artist.albums[0].name, 'Record');
    assert.equal(calls.filter(c => c.url.includes('/auth/login')).length, 1);
});

test('catalog artwork resolves relative CDN paths before searching or browsing an artist can play anything', async () => {
    const cover = 'images/b3/a9/46/6c/75054460b58f2a55e151db9a/';
    const annotations = {
        'TR:22': { name: 'Song', icon: { artUrl: cover + '_500W_500H.jpg' } },
        'AL:42': { name: 'Album', icon: { artId: cover } },
        'AR:1': { name: 'Artist', icon: { artUrl: '//content-images.p-cdn.com/images/artist.jpg' } },
        'SF:1:1': { name: 'Station', icon: { artUrl: 'https://fixture.invalid/station.jpg?width=500&height=500' } },
        'TR:23': { name: 'Missing cover' }
    };
    const { api, calls } = setup([premium(),
        catalogOK({ results: Object.keys(annotations), annotations }),
        catalogOK({ artistDetails: { topTracks: ['TR:22'], topAlbums: ['AL:42'] }, annotations })]);
    await api.login('test', 'test');
    const results = await api.search('song');
    const expectedCover = 'https://content-images.p-cdn.com/' + cover + '_500W_500H.jpg';
    assert.equal(results.songs[0].image, expectedCover);
    assert.equal(results.albums[0].image, expectedCover);
    assert.equal(results.artists[0].image, 'https://content-images.p-cdn.com/images/artist.jpg');
    assert.equal(results.stations[0].image, annotations['SF:1:1'].icon.artUrl);
    assert.equal(results.songs[1].image, null);
    const artist = await api.catalog.artist('AR:1');
    assert.equal(artist.songs[0].image, expectedCover);
    assert.equal(artist.albums[0].image, expectedCover);
    assert.equal(calls.some(call => /playback|createStation/.test(call.url)), false);
});

test('catalog playback also resolves relative artwork and preserves supplied absolute URLs', async () => {
    for (const [artUrl, expected] of [
        ['images/cover.jpg', 'https://content-images.p-cdn.com/images/cover.jpg'],
        ['https://fixture.invalid/cover.jpg?width=500&height=500', 'https://fixture.invalid/cover.jpg?width=500&height=500']
    ]) {
        const { api } = setup([premium(), catalogOK(catalogReply({ artUrl }))]);
        await api.login('test', 'test');
        const track = await api.catalog.start({ albumId: 'AL:42', ids: ['TR:22'] }, 0);
        assert.equal(track.albumArt[0].url, expected);
    }
});

test('a song requests its album plus the exact recording with the verified session', async () => {
    const { api, calls } = setup([premium(), catalogOK({ 'TR:22': { albumId: 'AL:42', rightsInfo: { hasInteractive: true } } }),
        catalogOK(catalogReply())]);
    await api.login('test', 'test');
    const selection = await api.catalog.selection('TR:22');
    const track = await api.catalog.start(selection, 0);
    assert.deepEqual(selection.ids, ['TR:22']);
    assert.deepEqual(JSON.parse(calls.at(-1).body), { sourceId: 'AL:42', itemId: 'TR:22',
        includeItem: true, includeSource: true, deviceUuid: 'test-device' });
    assert.equal(track.audioURL, 'https://fixture.invalid/approved.mp4');
    assert.equal(track.sourceIndex, 2, 'A single song can be the third track on the remote album');
    assert.equal(track.songTitle, 'Live recording');
    assert.equal(calls.at(-1).headers['X-AuthToken'], 'premium-token');
    assert.ok(calls.at(-1).url.endsWith('/v1/playback/source'));
});

test('wrong source, wrong recording, missing identity, radio, and simultaneous streams never supply audio', async () => {
    for (const [change, pattern] of [[{ pandoraId: 'TR:23' }, /recording/], [{ pandoraId: undefined }, /recording/],
        [{ sourceId: 'ST:0:42' }, /recording/], [{ type: 'AudioAd' }, /recording/],
        [{ playerStyle: 'NON_INTERACTIVE' }, /recording/], [{ type: 'SimStreamViolation' }, /another device/],
        [{ audioUrl: 'file:///etc/hosts' }, /playable audio/]]) {
        const { api } = setup([premium(), catalogOK(catalogReply(change))]);
        await api.login('test', 'test');
        await assert.rejects(api.catalog.start({ albumId: 'AL:42', ids: ['TR:22'] }, 0), pattern);
    }
});

test('restored tokens, Plus, restricted tracks and a server entitlement refusal cannot start catalog audio', async () => {
    const { api, calls } = setup([paid(), premium(), catalogOK({ 'TR:22': { rightsInfo: { hasInteractive: false } } }),
        { status: 400, body: { errorString: 'NO_ENTITLEMENTS' } }]);
    await assert.rejects(api.catalog.selection('TR:22'), /Premium/);
    assert.equal(calls.length, 0);
    await api.login('test', 'test');
    await assert.rejects(api.catalog.start({ albumId: 'AL:42', ids: ['TR:22'] }, 0), /Premium/);
    assert.equal(calls.length, 1);
    await api.login('test', 'test');
    await assert.rejects(api.catalog.selection('TR:22'), /unavailable/);
    await assert.rejects(api.catalog.start({ albumId: 'AL:42', ids: ['TR:22'] }, 0), /did not grant/);
    assert.equal(calls.some(c => /getFragment|createStation/.test(c.url)), false);
});

test('a Premium downgrade during auth recovery prevents replaying the source mutation', async () => {
    const { api, calls } = setup([premium(), { status: 401, body: {} }, paid()]);
    await api.login('test', 'test');
    api.onSessionExpired = async options => (await api.login('test', 'test', { ...options, refreshSession: true })).success;
    await assert.rejects(api.catalog.start({ albumId: 'AL:42', ids: ['TR:22'] }, 0), /Premium/);
    assert.equal(calls.filter(c => c.url.endsWith('/playback/source')).length, 1);
});

test('an empty ended acknowledgement reads the cursor once and checks the next recording', async () => {
    const { api, calls } = setup([premium(), catalogOK({ 'AL:42': { tracks: ['TR:21', 'TR:22'] } }),
        catalogOK({}), catalogOK(catalogReply())]);
    await api.login('test', 'test');
    const selection = await api.catalog.selection('AL:42');
    const next = await api.catalog.event(selection, { catalogId: 'TR:21', sourceIndex: 0 }, 'ended', 126, () => true, 1);
    assert.equal(next.catalogId, 'TR:22');
    assert.deepEqual(calls.slice(-2).map(c => new URL(c.url).pathname), ['/api/v1/event/ended', '/api/v1/playback/current']);
    assert.equal(JSON.parse(calls.at(-2).body).elapsedTime, 126);
});


test('an unidentified source cannot play, and a server-confirmed album end completes normally', async () => {
    const unidentified = catalogReply({ sourceId: undefined });
    delete unidentified.source;
    const { api, calls } = setup([premium(), catalogOK(unidentified),
        { status: 400, body: { errorString: 'SOURCE_ENDED' } }]);
    await api.login('test', 'test');
    const selection = { albumId: 'AL:42', ids: ['TR:22'] };
    await assert.rejects(api.catalog.start(selection, 0), /requested recording/);
    await api.catalog.event(selection, { catalogId: 'TR:22', sourceIndex: 0 }, 'ended', 180);
    assert.equal(calls.some(c => c.url.endsWith('/playback/current')), false);
});


test('a rights refusal in a successful HTTP response also stops catalog playback and event reporting', async () => {
    const revokedTrack = catalogReply();
    revokedTrack.annotations = { 'TR:22': { rightsInfo: { hasInteractive: false } } };
    const { api } = setup([premium(), catalogOK(revokedTrack), catalogOK({ errorString: 'NO_ENTITLEMENTS', errorCode: 0 })]);
    await api.login('test', 'test');
    const selection = { albumId: 'AL:42', ids: ['TR:22'] };
    await assert.rejects(api.catalog.start(selection, 0), /unavailable/);
    await assert.rejects(api.catalog.event(selection, { catalogId: 'TR:22', sourceIndex: 0 }, 'progress', 30), /did not grant/);
});
