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
const premium = () => ({ status: 200, body: { authToken: 'premium-token', config: { branding: 'PandoraPremium', flags: ['onDemand'] } } });

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

test('Premium-only selections recheck the account and require Pandora to confirm the mode', async () => {
    const available = modeResponse();
    available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
    const confirmed = { ...available, currentModeId: 5 };
    const { api, calls } = setup([
        premium(), { status: 200, body: available }, premium(), { status: 200, body: confirmed }
    ]);
    await api.login('test@example.invalid', 'test-password');
    assert.equal((await api.setStationMode('station-1', 5)).success, true);
    assert.deepEqual(calls.slice(1).map(call => new URL(call.url).pathname), [
        '/api/v1/interactiveradio/getAvailableModesSimple',
        '/api/v1/auth/login',
        '/api/v1/interactiveradio/setAndGetAvailableModes'
    ]);
});

test('downgrades, failed verification and missing credentials block Premium mode requests', async () => {
    const available = modeResponse();
    available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
    for (const nextLogin of [paid(), { status: 401, body: { message: 'Session expired' } }, null]) {
        const { api, state, calls } = setup([
            premium(), { status: 200, body: available }, ...(nextLogin ? [nextLogin] : []),
            { status: 200, body: available }
        ]);
        await api.login('test@example.invalid', 'test-password');
        if (!nextLogin) state.credentials = null;
        assert.equal((await api.setStationMode('station-1', 5)).success, false);
        assert.equal(calls.some(call => call.url.endsWith('/setAndGetAvailableModes')), false);
        assert.equal(api.hasPremiumAccess(), false);
        assert.equal((await api.getStationModes('station-1')).modes.find(mode => mode.id === 5).available, false);
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
        premium(), { status: 200, body: available }, premium(),
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
            premium(), { status: 200, body: available }, premium(),
            verification ? blocked() : { status: 401, body: { errorCode: 1000 } },
            ...(verification ? [] : [premium()]),
            { status: 200, body: { ...available, currentModeId: 5 } }
        ]);
        await api.login('test@example.invalid', 'test-password');
        api.onSessionExpired = async options => (await api.login('test@example.invalid', 'test-password', { ...options, refreshSession: true })).success;
        api.onVerificationRequired = async () => true;
        assert.equal((await api.setStationMode('station-1', 5)).success, true);
        assert.equal(calls.filter(call => call.url.endsWith('/setAndGetAvailableModes')).length, 2);
        assert.equal(api.hasPremiumAccess(), true);
    }
});

test('logging out during a Premium check cannot restore credentials or submit the mode', async () => {
    const available = modeResponse();
    available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
    let completeLogin;
    let loginStarted;
    const checking = new Promise(resolve => { loginStarted = resolve; });
    const { api, state, calls } = setup([
        premium(), { status: 200, body: available },
        () => { loginStarted(); return new Promise(resolve => { completeLogin = resolve; }); },
        { status: 200, body: { ...available, currentModeId: 5 } }
    ]);
    await api.login('test@example.invalid', 'test-password');
    const change = api.setStationMode('station-1', 5);
    await checking;
    api.logout();
    completeLogin(premium());
    await change;
    assert.equal(api.isAuthenticated(), false);
    assert.equal(api.hasPremiumAccess(), false);
    assert.equal(state.credentials, null);
    assert.equal(calls.some(call => call.url.endsWith('/setAndGetAvailableModes')), false);
});

test('a cancelled station change stops after preflight, Premium verification or CAPTCHA', async () => {
    for (const stage of ['preflight', 'premium', 'captcha']) {
        const available = modeResponse();
        available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
        let complete;
        let started;
        const waiting = new Promise(resolve => { started = resolve; });
        const deferred = () => { started(); return new Promise(resolve => { complete = resolve; }); };
        const { api, calls } = setup([
            premium(),
            stage === 'preflight' ? deferred : { status: 200, body: available },
            stage === 'premium' ? deferred : premium(),
            blocked()
        ]);
        await api.login('test@example.invalid', 'test-password');
        api.onVerificationRequired = deferred;
        let current = true;
        const changing = api.setStationMode('station-1', 5, { isCurrent: () => current });
        await waiting;
        current = false;
        complete(stage === 'preflight' ? { status: 200, body: available } : stage === 'premium' ? premium() : true);
        const result = await changing;
        assert.equal(result.success, false);
        assert.equal(result.cancelled, true);
        assert.equal(calls.filter(call => call.url.endsWith('/setAndGetAvailableModes')).length, stage === 'captcha' ? 1 : 0);
        assert.equal(api.hasPremiumAccess(), true, 'Station cancellation must not erase the existing account proof');
    }
});

test('eligibility and cancellation are checked again after asynchronous cookie access', async () => {
    for (const cancel of [false, true]) {
        const available = modeResponse();
        available.availableModes.find(mode => mode.modeId === 5).isModeAvailable = true;
        const { api, calls, electron, cookies } = setup([premium(), { status: 200, body: available }, premium()]);
        await api.login('test@example.invalid', 'test-password');
        let finishCookieRead;
        let started;
        const waiting = new Promise(resolve => { started = resolve; });
        let reads = 0;
        electron.session.defaultSession.cookies.get = async () => {
            if (++reads === 3) {
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
