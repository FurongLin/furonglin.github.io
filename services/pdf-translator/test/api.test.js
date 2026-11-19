import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { createConfigHandler } from '../api/config.js';
import { createSessionHandler } from '../api/session.js';
import { createTranslateHandler } from '../api/translate.js';
import { MAX_BODY_BYTES, getConfig } from '../lib/config.js';
import { readJson } from '../lib/http.js';
import { request, TestResponse, TEST_ENV, testAuthenticator, translationBody, verifiedPayload } from './helpers.js';

test('public config exposes readiness and limits without private identity or API key', async () => {
    for (const [env, signInReady, translationReady] of [[{}, false, false], [{ ...TEST_ENV, GEMINI_FREE_TIER_API_KEY: '' }, true, false], [TEST_ENV, true, true]]) {
        const res = new TestResponse();
        await createConfigHandler({ env })(request({ method: 'GET' }), res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json(), {
            googleClientId: env.GOOGLE_CLIENT_ID || '', maxPdfBytes: 2_097_152,
            maxPagesPerBatch: 5, maxDocumentPages: 100, signInReady, translationReady
        });
        assert.equal(res.body.includes('owner@example.test'), false);
        assert.equal(res.body.includes(TEST_ENV.GEMINI_FREE_TIER_API_KEY), false);
        assert.equal(res.headers['cache-control'], 'no-store');
    }
});

test('CORS allows only exact configured origins, handles preflight and does not act as authentication', async () => {
    const handler = createSessionHandler({ env: TEST_ENV, authenticateRequest: testAuthenticator() });
    const good = new TestResponse();
    await handler(request({ method: 'OPTIONS', headers: { origin: 'https://furonglin.github.io', 'access-control-request-method': 'POST', authorization: '' } }), good);
    assert.equal(good.statusCode, 204);
    assert.equal(good.headers['access-control-allow-origin'], 'https://furonglin.github.io');
    assert.equal(good.headers['access-control-allow-headers'], 'Authorization, Content-Type');
    for (const origin of ['https://furonglin.github.io.attacker.test', 'null', 'https://other.example']) {
        const res = new TestResponse();
        await handler(request({ headers: { origin } }), res);
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().error.code, 'ORIGIN_NOT_ALLOWED');
        assert.equal(res.headers['access-control-allow-origin'], undefined);
        assert.equal(res.headers['cache-control'], 'no-store');
    }
    const unsigned = new TestResponse();
    await handler(request({ headers: { origin: 'https://furonglin.github.io', authorization: '' } }), unsigned);
    assert.equal(unsigned.statusCode, 401);
    assert.deepEqual(getConfig({ ...TEST_ENV, ALLOWED_ORIGINS: 'https://custom.example,*' }).allowedOrigins, ['https://custom.example']);
});

test('session uses the real auth helper and returns only verified profile fields', async () => {
    const calls = [];
    const handler = createSessionHandler({ env: TEST_ENV, authenticateRequest: testAuthenticator(verifiedPayload(), calls) });
    const res = new TestResponse();
    await handler(request(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.json()).sort(), ['email', 'exp', 'name']);
    assert.equal(calls.length, 1);
    for (const payload of [verifiedPayload({ email: 'stranger@example.test' }), verifiedPayload({ email_verified: false })]) {
        const denied = new TestResponse();
        await createSessionHandler({ env: TEST_ENV, authenticateRequest: testAuthenticator(payload) })(request(), denied);
        assert.equal(denied.statusCode, 403);
    }
    const missingConfig = new TestResponse();
    await createSessionHandler({ env: {}, authenticateRequest: testAuthenticator() })(request(), missingConfig);
    assert.equal(missingConfig.statusCode, 503);
});

test('wrong API methods receive 405 and no-store', async () => {
    const res = new TestResponse();
    await createConfigHandler({ env: TEST_ENV })(request({ method: 'POST' }), res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'GET, OPTIONS');
    assert.equal(res.headers['cache-control'], 'no-store');
});

test('translation re-verifies each request, clamps the range and preserves partial output status', async () => {
    const calls = [];
    const body = await translationBody(3);
    let input;
    const handler = createTranslateHandler({
        env: TEST_ENV,
        authenticateRequest: testAuthenticator(verifiedPayload(), calls),
        translate: async (document) => {
            input = document;
            return { text: 'partial translation', complete: false, finishReason: 'MAX_TOKENS' };
        }
    });
    for (let index = 0; index < 2; index += 1) {
        const res = new TestResponse();
        await handler(request({ body }), res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json(), {
            text: 'partial translation', complete: false, finishReason: 'MAX_TOKENS',
            startPage: 1, endPage: 3, pageCount: 3, model: 'gemini-3.5-flash-lite'
        });
    }
    assert.equal(calls.length, 2);
    assert.equal(input.pdfBase64, body.pdfBase64);
    assert.equal(input.endPage, 3);
});

test('translation denies other accounts and unsigned requests before reading PDFs or calling Gemini', async () => {
    let geminiCalls = 0;
    for (const options of [
        { authenticateRequest: testAuthenticator(verifiedPayload({ email: 'stranger@example.test' })), headers: {}, expected: 403 },
        { authenticateRequest: testAuthenticator(), headers: { authorization: '' }, expected: 401 }
    ]) {
        const req = request({ raw: 'deliberately invalid JSON', headers: options.headers });
        const res = new TestResponse();
        await createTranslateHandler({ env: TEST_ENV, authenticateRequest: options.authenticateRequest, translate: async () => { geminiCalls += 1; } })(req, res);
        assert.equal(res.statusCode, options.expected);
        assert.equal(req.readableDidRead, false);
    }
    assert.equal(geminiCalls, 0);
});

test('translation fails closed for missing key or identity and safely classifies invalid input', async () => {
    for (const env of [{}, { ...TEST_ENV, GEMINI_FREE_TIER_API_KEY: '', GEMINI_API_KEY: 'legacy-unverified-key' }, { ...TEST_ENV, GEMINI_MODEL: 'gemini-3.1-pro-preview' }]) {
        const res = new TestResponse();
        const req = request();
        await createTranslateHandler({ env, authenticateRequest: testAuthenticator(), translate: () => assert.fail('Disabled translation reached Gemini') })(req, res);
        assert.equal(res.statusCode, 503);
        assert.equal(req.readableDidRead, false);
    }
    const handler = createTranslateHandler({ env: TEST_ENV, authenticateRequest: testAuthenticator() });
    for (const [req, code, status] of [
        [request({ raw: '{' }), 'INVALID_JSON', 400],
        [request({ body: [] }), 'INVALID_JSON', 400],
        [request({ raw: '{}', headers: { 'content-type': 'text/plain' } }), 'JSON_REQUIRED', 415],
        [request({ raw: '{}', headers: { 'content-encoding': 'gzip' } }), 'CONTENT_ENCODING_NOT_ALLOWED', 415],
        [request({ raw: '{}', headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }), 'BODY_TOO_LARGE', 413],
        [request({ body: await translationBody(2, { pdfBase64: Buffer.from('not PDF').toString('base64') }) }), 'INVALID_PDF', 400],
        [request({ body: await translationBody(2, { startPage: 3, endPage: 3 }) }), 'INVALID_PAGE_RANGE', 400]
    ]) {
        const res = new TestResponse();
        await handler(req, res);
        assert.equal(res.statusCode, status);
        assert.equal(res.json().error.code, code);
        assert.equal(res.headers['cache-control'], 'no-store');
    }
});

test('JSON byte limit is enforced on chunked bodies, independently of Content-Length or req.body', async () => {
    const req = request({ chunks: ['{"text":"', 'x'.repeat(MAX_BODY_BYTES), '"}'] });
    Object.defineProperty(req, 'body', { get() { throw new Error('must not access Vercel lazy parser'); } });
    await assert.rejects(readJson(req), { status: 413, code: 'BODY_TOO_LARGE' });
    assert.equal(req.destroyed, false);
    await assert.rejects(readJson(request({ raw: Buffer.from([0x7b, 0xff, 0x7d]) })), { code: 'INVALID_JSON' });
});

test('real Node HTTP chunked upload gets a safe 413 without calling Gemini', async (context) => {
    const handler = createTranslateHandler({ env: TEST_ENV, authenticateRequest: testAuthenticator() });
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const result = await new Promise((resolve, reject) => {
        const req = httpRequest({
            hostname: '127.0.0.1', port: server.address().port, path: '/api/translate', method: 'POST',
            headers: { authorization: 'Bearer synthetic.test.token', 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
        });
        req.on('error', reject);
        req.write('{"text":"');
        req.write('x'.repeat(MAX_BODY_BYTES));
        req.end('"}');
    });
    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.body).error.code, 'BODY_TOO_LARGE');
    assert.equal(result.headers['cache-control'], 'no-store');
});

test('translation aborts upstream when the client closes, but normal request close does not abort it', async () => {
    const body = await translationBody();
    for (const event of ['request-close', 'response-close']) {
        const req = request({ body });
        const res = new TestResponse();
        let observedSignal;
        const handler = createTranslateHandler({
            env: TEST_ENV,
            authenticateRequest: testAuthenticator(),
            translate: async (document, config, { signal }) => {
                observedSignal = signal;
                if (event === 'response-close') {
                    res.destroyed = true;
                    res.emit('close');
                } else {
                    req.emit('close');
                }
                return { text: 'translation', complete: true, finishReason: 'STOP' };
            }
        });
        await handler(req, res);
        assert.equal(observedSignal.aborted, event === 'response-close');
        assert.equal(req.listenerCount('aborted'), 0);
    }
});
