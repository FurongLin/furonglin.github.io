import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthenticator } from '../lib/auth.js';
import { getConfig } from '../lib/config.js';
import { request, TEST_ENV, testAuthenticator, verifiedPayload } from './helpers.js';

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
