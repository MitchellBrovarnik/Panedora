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
            const next = responses.shift();
            assert.ok(next, 'Unexpected extra request');
            if (next instanceof Error) throw next;
            return { ok: next.status === 200, status: next.status, text: async () => JSON.stringify(next.body) };
        } }
    };
    const config = {
        getAuthToken: () => state.authToken,
        setAuthToken: value => { state.authToken = value; },
        setCsrfToken: value => { state.csrfToken = value; },
        setCredentials: (email, password) => { state.credentials = { email, password }; },
        setListenerId: value => { state.listenerId = value; }
    };
    const API = loadModule(path.join(__dirname, '..', 'pandora-api.js'), { electron, './config': config });
    return { api: new API(), state, cookies, calls };
}

const blocked = () => ({ status: 403, body: { ...challenge } });
const paid = () => ({ status: 200, body: { authToken: 'new-token', listenerId: 'listener', config: { branding: 'PandoraPlus' } } });

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
