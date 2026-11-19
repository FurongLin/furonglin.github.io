import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthenticator } from '../lib/auth.js';
import { getConfig } from '../lib/config.js';
import { createSessionHandler } from '../api/session.js';
import { prepareRequest } from '../lib/http.js';
import { createOwnerSession, clearOwnerSessionCookie, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from '../lib/session.js';
import { request, TestResponse, TEST_ENV, testAuthenticator, verifiedPayload } from './helpers.js';

test('the real auth helper passes the header token and fixed audience to the Google verifier', async () => {
    const calls = [];
    const authenticate = testAuthenticator(verifiedPayload({ email: ' OWNER@EXAMPLE.TEST ' }), calls);
    const user = await authenticate(request(), getConfig(TEST_ENV));
    assert.equal(user.email, 'owner@example.test');
    assert.deepEqual(Object.keys(user).sort(), ['email', 'exp', 'name']);
    assert.deepEqual(calls, [{ idToken: 'synthetic.test.token', audience: TEST_ENV.GOOGLE_CLIENT_ID }]);
});

test('auth fails closed if either required identity setting is missing', async () => {
    for (const env of [{}, { GOOGLE_CLIENT_ID: TEST_ENV.GOOGLE_CLIENT_ID }, { ALLOWED_GOOGLE_EMAIL: TEST_ENV.ALLOWED_GOOGLE_EMAIL }]) {
        const calls = [];
        await assert.rejects(testAuthenticator(verifiedPayload(), calls)(request(), getConfig(env)), { status: 503, code: 'SIGN_IN_NOT_CONFIGURED' });
        assert.equal(calls.length, 0);
    }
});

test('auth rejects another account, unverified emails and mismatched optional subject', async () => {
    for (const payload of [
        verifiedPayload({ email: 'another@example.test' }),
        verifiedPayload({ email: 'owner@example.test.attacker.test' }),
        verifiedPayload({ email_verified: false }),
        verifiedPayload({ email_verified: 'true' }),
        verifiedPayload({ email: undefined })
    ]) {
        await assert.rejects(testAuthenticator(payload)(request(), getConfig(TEST_ENV)), { status: 403, code: 'ACCOUNT_NOT_ALLOWED' });
    }
    await assert.rejects(testAuthenticator()(request(), getConfig({ ...TEST_ENV, ALLOWED_GOOGLE_SUB: 'another-subject' })), { status: 403 });
    await testAuthenticator()(request(), getConfig({ ...TEST_ENV, ALLOWED_GOOGLE_SUB: 'synthetic-owner-subject' }));
});

test('auth never falls back to client email, cookies, query, decoded token or a previous session', async () => {
    const authenticate = createAuthenticator({ verifyIdToken: async () => { throw new Error('synthetic verifier rejection'); } });
    const req = request({ body: { email: TEST_ENV.ALLOWED_GOOGLE_EMAIL, verified: true } });
    req.query = { email: TEST_ENV.ALLOWED_GOOGLE_EMAIL };
    req.headers.cookie = 'session=synthetic';
    await assert.rejects(authenticate(req, getConfig(TEST_ENV)), { status: 401, code: 'INVALID_ID_TOKEN' });
    for (const authorization of ['', 'Basic synthetic', 'Bearer token extra', 'Bearer token\n']) {
        await assert.rejects(testAuthenticator()(request({ headers: { authorization } }), getConfig(TEST_ENV)), { status: 401 });
    }
});

test('auth also rejects expired or incomplete verifier payloads', async () => {
    for (const payload of [undefined, verifiedPayload({ exp: 0 }), verifiedPayload({ exp: '99999999999' })]) {
        const authenticate = createAuthenticator({ verifyIdToken: async () => ({ getPayload: () => payload }) });
        await assert.rejects(authenticate(request(), getConfig(TEST_ENV)), { status: 401, code: 'INVALID_ID_TOKEN' });
    }
});

const SESSION_SECRET = 'synthetic-session-secret-for-tests-only-123456789';
const ALLOWED_ORIGIN = 'https://furonglin.github.io';
const sessionConfig = () => ({ ...getConfig(TEST_ENV), ownerSessionSecret: SESSION_SECRET });
const cookiePair = (session) => session.cookie.split(';')[0];
const cookieRequest = (cookie, headers = {}) => request({
    headers: { authorization: '', cookie, origin: ALLOWED_ORIGIN, ...headers }
});

test('owner sessions use an encrypted, scoped 30-day HttpOnly Secure partitioned cookie', async () => {
    const now = 1_800_000_000_000;
    const session = createOwnerSession(verifiedPayload(), sessionConfig(), { now: () => now });
    assert.equal(session.profile.exp, now / 1000 + SESSION_MAX_AGE_SECONDS);
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Max-Age=2592000']) {
        assert.equal(session.cookie.includes(attribute), true);
    }
    assert.equal(session.cookie.startsWith(`${SESSION_COOKIE_NAME}=`), true);
    assert.equal(session.cookie.includes('Domain='), false);
    assert.equal(session.cookie.includes(TEST_ENV.ALLOWED_GOOGLE_EMAIL), false);
    assert.equal(session.cookie.includes('Test Owner'), false);
    const googleCalls = [];
    const authenticate = createAuthenticator({
        now: () => now + 29 * 24 * 60 * 60 * 1000,
        verifyIdToken: async () => { googleCalls.push(true); throw new Error('Google should not be called for cookie restoration'); }
    });
    assert.deepEqual(await authenticate(cookieRequest(cookiePair(session)), sessionConfig()), session.profile);
    assert.equal(googleCalls.length, 0);
});

test('owner cookies expire at 30 days without sliding renewal and reject altered ciphertext', async () => {
    const now = 1_800_000_000_000;
    const session = createOwnerSession(verifiedPayload(), sessionConfig(), { now: () => now });
    const expired = createAuthenticator({ now: () => now + SESSION_MAX_AGE_SECONDS * 1000 });
    await assert.rejects(expired(cookieRequest(cookiePair(session)), sessionConfig()), { status: 401, code: 'INVALID_SESSION' });
    const authenticate = createAuthenticator({ now: () => now });
    const altered = cookiePair(session).split('.');
    altered[2] = (altered[2][0] === 'A' ? 'B' : 'A') + altered[2].slice(1);
    await assert.rejects(authenticate(cookieRequest(altered.join('.')), sessionConfig()), { status: 401, code: 'INVALID_SESSION' });
    for (const cookie of [`${SESSION_COOKIE_NAME}=bad`, `${cookiePair(session)}; ${cookiePair(session)}`, `${SESSION_COOKIE_NAME}=${'x'.repeat(4000)}`]) {
        await assert.rejects(authenticate(cookieRequest(cookie), sessionConfig()), { status: 401, code: 'INVALID_SESSION' });
    }
});

test('session cookies are invalidated by owner, OAuth audience, subject and signing-secret changes', async () => {
    const config = sessionConfig();
    const session = createOwnerSession(verifiedPayload(), config);
    for (const changed of [
        { allowedEmail: 'different@example.test' },
        { googleClientId: 'different-client.apps.googleusercontent.com' },
        { allowedSub: 'different-subject' },
        { ownerSessionSecret: 'a-different-synthetic-session-secret-1234567890' }
    ]) {
        await assert.rejects(createAuthenticator()(cookieRequest(cookiePair(session)), { ...config, ...changed }), { status: 401, code: 'INVALID_SESSION' });
    }
    await assert.rejects(createAuthenticator()(cookieRequest(cookiePair(session)), { ...config, signInReady: false }), { status: 503, code: 'SIGN_IN_NOT_CONFIGURED' });
});

test('every cookie-authenticated endpoint requires an exact allowlisted Origin against CSRF', async () => {
    const config = sessionConfig();
    const session = createOwnerSession(verifiedPayload(), config);
    for (const origin of ['', 'null', 'https://furonglin.github.io.attacker.test']) {
        await assert.rejects(createAuthenticator()(cookieRequest(cookiePair(session), { origin }), config), { status: 403, code: 'ORIGIN_NOT_ALLOWED' });
    }
    const res = new TestResponse();
    prepareRequest(request({ headers: { origin: ALLOWED_ORIGIN } }), res, config, 'POST');
    assert.equal(res.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
    assert.equal(res.headers['cache-control'], 'no-store');
});

test('an invalid Authorization header never falls back to an otherwise valid owner cookie', async () => {
    const config = sessionConfig();
    const session = createOwnerSession(verifiedPayload(), config);
    for (const authorization of ['Basic token', 'Bearer rejected.google.token']) {
        const authenticate = createAuthenticator({ verifyIdToken: async () => { throw new Error('synthetic rejection'); } });
        await assert.rejects(authenticate(cookieRequest(cookiePair(session), { authorization }), config), { status: 401 });
    }
});

test('missing or malformed session secrets fail closed while Google Bearer auth remains supported', async () => {
    const config = sessionConfig();
    const session = createOwnerSession(verifiedPayload(), config);
    for (const ownerSessionSecret of ['', undefined, 'too-short', 'x'.repeat(1025)]) {
        const changed = { ...config, ownerSessionSecret };
        assert.throws(() => createOwnerSession(verifiedPayload(), changed), { status: 503, code: 'SESSION_NOT_CONFIGURED' });
        await assert.rejects(createAuthenticator()(cookieRequest(cookiePair(session)), changed), { status: 503, code: 'SESSION_NOT_CONFIGURED' });
        assert.equal((await testAuthenticator()(request(), changed)).email, TEST_ENV.ALLOWED_GOOGLE_EMAIL);
    }
});

test('session POST signs in with Google once, restores using the cookie, and does not renew its expiry', async () => {
    const calls = [];
    const env = { ...TEST_ENV, OWNER_SESSION_SECRET: SESSION_SECRET };
    const handler = createSessionHandler({ env, authenticateRequest: testAuthenticator(verifiedPayload(), calls) });
    const signedIn = new TestResponse();
    await handler(request({ body: {}, headers: { origin: ALLOWED_ORIGIN } }), signedIn);
    assert.equal(signedIn.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(signedIn.json().exp > verifiedPayload().exp, true);
    const cookie = signedIn.headers['set-cookie'].split(';')[0];
    const restored = new TestResponse();
    await handler(cookieRequest(cookie), restored);
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(restored.json(), signedIn.json());
    assert.equal(restored.headers['set-cookie'], undefined);
    assert.equal(calls.length, 1);
    assert.equal(restored.headers['access-control-allow-credentials'], 'true');
});

test('explicit JSON signout clears the same cookie without needing an active identity or session', async () => {
    const calls = [];
    const handler = createSessionHandler({ env: {}, authenticateRequest: testAuthenticator(verifiedPayload(), calls) });
    const res = new TestResponse();
    await handler(request({ body: { action: 'signout' }, headers: { authorization: '', origin: ALLOWED_ORIGIN } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { signedOut: true });
    assert.equal(res.headers['set-cookie'], clearOwnerSessionCookie());
    assert.match(res.headers['set-cookie'], /Max-Age=0/);
    assert.equal(calls.length, 0);
    for (const origin of ['', 'https://attacker.example']) {
        const denied = new TestResponse();
        await handler(request({ body: { action: 'signout' }, headers: { origin } }), denied);
        assert.equal(denied.statusCode, 403);
        assert.equal(denied.headers['set-cookie'], undefined);
    }
});

test('session POST rejects oversized actions, unknown actions and refuses to issue with an inactive secret', async () => {
    const handler = createSessionHandler({ env: TEST_ENV, authenticateRequest: testAuthenticator() });
    for (const [body, status, code] of [
        [{ ignored: 'x'.repeat(1025) }, 413, 'BODY_TOO_LARGE'],
        [{ action: 'unknown' }, 400, 'INVALID_SESSION_ACTION'],
        [{}, 503, 'SESSION_NOT_CONFIGURED']
    ]) {
        const res = new TestResponse();
        await handler(request({ body }), res);
        assert.equal(res.statusCode, status);
        assert.equal(res.json().error.code, code);
        assert.equal(res.headers['set-cookie'], undefined);
    }
});
