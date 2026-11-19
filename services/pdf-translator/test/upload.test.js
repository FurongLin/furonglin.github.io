import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createUploadHandler } from '../api/upload.js';
import { createTranslateHandler } from '../api/translate.js';
import { getConfig, MAX_PDF_BYTES, MAX_UPLOAD_BYTES } from '../lib/config.js';
import { deleteUpload, getUploadedFile, readUploadToken, startUpload } from '../lib/uploads.js';
import { request, TestResponse, TEST_ENV, testAuthenticator, verifiedPayload } from './helpers.js';

// All URLs, credentials and metadata below are synthetic mock fixtures.
const UPLOAD_ENV = {
    ...TEST_ENV,
    OWNER_SESSION_SECRET: 'synthetic-upload-session-secret-for-tests-only-123456789'
};
const GOOGLE_API = 'https://generativelanguage.googleapis.com';
const UPLOAD_URL = `${GOOGLE_API}/upload/v1beta/files?upload_id=synthetic-one-upload-capability&upload_protocol=resumable`;
const TEN_MIB = 10 * 1024 * 1024;
const config = () => getConfig(UPLOAD_ENV);
const OWNER = TEST_ENV.ALLOWED_GOOGLE_EMAIL;

function mockStartResponse(uploadUrl = UPLOAD_URL) {
    return new Response(null, { headers: { 'x-goog-upload-url': uploadUrl } });
}

async function uploadFixture(overrides = {}) {
    const result = await startUpload({ sizeBytes: TEN_MIB, pageCount: 20, ...overrides }, OWNER, config(), async () => mockStartResponse());
    return { ...result, upload: readUploadToken(result.fileToken, OWNER, config()) };
}

function fileMetadata(upload, overrides = {}) {
    return { name: upload.name, mimeType: 'application/pdf', sizeBytes: String(upload.sizeBytes), state: 'ACTIVE', ...overrides };
}

function signedFixture(payload, email = OWNER) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', UPLOAD_ENV.OWNER_SESSION_SECRET)
        .update('pdf-upload-v1\0').update(email).update('\0').update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
}

test('10 MiB upload initiation uses the fixed Google endpoint, server-generated file name and header-only key', async () => {
    let sent;
    const result = await startUpload({ sizeBytes: TEN_MIB, pageCount: 100, name: 'files/client-chosen-name' }, OWNER, config(), async (url, options) => {
        sent = { url, options };
        return mockStartResponse();
    });
    const upload = readUploadToken(result.fileToken, OWNER, config());
    assert.equal(MAX_UPLOAD_BYTES, TEN_MIB);
    assert.equal(result.uploadUrl, UPLOAD_URL);
    assert.match(upload.name, /^files\/pdf-[a-f0-9]{32}$/);
    assert.notEqual(upload.name, 'files/client-chosen-name');
    assert.equal(upload.sizeBytes, TEN_MIB);
    assert.equal(upload.pageCount, 100);
    assert.equal(upload.exp > Date.now(), true);
    assert.equal(upload.exp <= Date.now() + 60 * 60 * 1000, true);
    assert.equal(sent.url, `${GOOGLE_API}/upload/v1beta/files`);
    assert.equal(sent.options.redirect, 'error');
    assert.equal(sent.options.headers['x-goog-api-key'], TEST_ENV.GEMINI_FREE_TIER_API_KEY);
    assert.equal(sent.options.headers['X-Goog-Upload-Header-Content-Length'], String(TEN_MIB));
    assert.equal(sent.options.headers['X-Goog-Upload-Header-Content-Type'], 'application/pdf');
    assert.equal(sent.options.headers['X-Goog-Upload-Command'], 'start');
    assert.equal(sent.options.headers['X-Goog-Upload-Protocol'], 'resumable');
    assert.deepEqual(JSON.parse(sent.options.body), { file: { name: upload.name } });
    assert.equal(JSON.stringify(result).includes(TEST_ENV.GEMINI_FREE_TIER_API_KEY), false);
    assert.equal(JSON.stringify(result).includes(OWNER), false);
});

test('upload initiation rejects size and page-limit violations before any Google request', async () => {
    let calls = 0;
    for (const values of [
        { sizeBytes: TEN_MIB + 1, pageCount: 1 },
        { sizeBytes: MAX_PDF_BYTES, pageCount: 1 },
        { sizeBytes: -1, pageCount: 1 },
        { sizeBytes: '10485760', pageCount: 1 },
        { sizeBytes: TEN_MIB, pageCount: 0 },
        { sizeBytes: TEN_MIB, pageCount: 101 },
        { sizeBytes: TEN_MIB, pageCount: 1.5 }
    ]) {
        await assert.rejects(startUpload(values, OWNER, config(), async () => { calls += 1; }), { status: 400, code: 'INVALID_UPLOAD' });
    }
    assert.equal(calls, 0);
});

test('upload credentials reject another owner, tampering, expiry, malformed shape and raw URLs', async () => {
    const { fileToken, upload } = await uploadFixture();
    assert.throws(() => readUploadToken(fileToken, 'second@example.test', config()), { status: 400, code: 'INVALID_UPLOAD' });
    assert.throws(() => readUploadToken(fileToken, OWNER, { ...config(), ownerSessionSecret: 'a-different-synthetic-upload-secret-123456789' }), { code: 'INVALID_UPLOAD' });
    const [payload, signature] = fileToken.split('.');
    const changedSignature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const lastIndex = alphabet.indexOf(signature.at(-1));
    const noncanonicalSignature = signature.slice(0, -1) + alphabet[lastIndex | 1];
    assert.deepEqual(Buffer.from(noncanonicalSignature, 'base64url'), Buffer.from(signature, 'base64url'));
    for (const token of [
        `${payload}.${changedSignature}`, `${payload}.${noncanonicalSignature}`, '', 'unsigned', UPLOAD_URL,
        `${GOOGLE_API}/v1beta/${upload.name}`,
        signedFixture(null), signedFixture([]), signedFixture(123), signedFixture({}),
        signedFixture({ ...upload, exp: Date.now() - 1 }),
        signedFixture({ ...upload, name: 'files/not-server-generated' }),
        signedFixture({ ...upload, name: 'https://attacker.example/private' }),
        signedFixture({ ...upload, sizeBytes: TEN_MIB + 1 }),
        signedFixture({ ...upload, pageCount: 101 })
    ]) {
        assert.throws(() => readUploadToken(token, OWNER, config()), { status: 400, code: 'INVALID_UPLOAD' });
    }
});

test('Google upload capability URL validation rejects foreign hosts, extra credentials and unexpected paths', async () => {
    for (const url of [
        'https://attacker.example/upload/v1beta/files?upload_id=x&upload_protocol=resumable',
        'https://generativelanguage.googleapis.com.attacker.example/upload/v1beta/files?upload_id=x&upload_protocol=resumable',
        `${GOOGLE_API}/v1beta/files?upload_id=x&upload_protocol=resumable`,
        `${UPLOAD_URL}&key=synthetic-unexpected-key`,
        `${UPLOAD_URL}&upload_id=duplicate`,
        `${UPLOAD_URL}#fragment`,
        UPLOAD_URL.replace('https://', 'https://user:password@'),
        'http://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x&upload_protocol=resumable',
        'not a URL'
    ]) {
        await assert.rejects(startUpload({ sizeBytes: TEN_MIB, pageCount: 10 }, OWNER, config(), async () => mockStartResponse(url)), { status: 502, code: 'UPLOAD_UNAVAILABLE' });
    }
});

test('uploaded metadata must match the signed name, exact size and PDF MIME before translating', async () => {
    const { upload } = await uploadFixture();
    const calls = [];
    const uri = await getUploadedFile(upload, config(), async (url, options) => {
        calls.push({ url, options });
        return Response.json(fileMetadata(upload, { uri: 'https://attacker.example/ignored-file-uri' }));
    });
    assert.equal(uri, `${GOOGLE_API}/v1beta/${upload.name}`);
    assert.equal(calls[0].url, uri);
    assert.equal(calls[0].options.redirect, 'error');
    for (const mismatch of [
        { name: 'files/pdf-00000000000000000000000000000000' },
        { mimeType: 'text/html' },
        { sizeBytes: String(TEN_MIB - 1) },
        { sizeBytes: String(TEN_MIB + 1) }
    ]) {
        await assert.rejects(getUploadedFile(upload, config(), async () => Response.json(fileMetadata(upload, mismatch))), { status: 502, code: 'UPLOAD_UNAVAILABLE' });
    }
    await assert.rejects(getUploadedFile(upload, config(), async () => Response.json(fileMetadata(upload, { state: 'FAILED' }))), { status: 422, code: 'INVALID_PDF' });
    assert.equal(await getUploadedFile(upload, config(), async () => Response.json(fileMetadata(upload, { state: 'PROCESSING' }))), null);
    for (const status of [403, 404]) {
        assert.equal(await getUploadedFile(upload, config(), async () => new Response(null, { status })), null);
    }
});

test('Google upload failures return stable safe errors rather than upstream bodies', async () => {
    const secretText = 'synthetic-sensitive-upstream-body';
    for (const status of [400, 401, 500]) {
        await assert.rejects(startUpload({ sizeBytes: TEN_MIB, pageCount: 10 }, OWNER, config(), async () => new Response(secretText, { status })),
            (error) => error.code === 'UPLOAD_UNAVAILABLE' && !error.message.includes(secretText));
    }
    await assert.rejects(startUpload({ sizeBytes: TEN_MIB, pageCount: 10 }, OWNER, config(), async () => new Response(secretText, { status: 429 })), { status: 429, code: 'GEMINI_RATE_LIMITED' });
});

test('upload API authenticates every start, status and delete operation and returns only operation data', async () => {
    const authCalls = [];
    const googleCalls = [];
    let upload;
    const handler = createUploadHandler({
        env: UPLOAD_ENV,
        authenticateRequest: testAuthenticator(verifiedPayload(), authCalls),
        fetchImpl: async (url, options) => {
            googleCalls.push({ url, options });
            if (options.method === 'POST') return mockStartResponse();
            if (options.method === 'GET') return Response.json(fileMetadata(upload));
            return new Response(null, { status: 204 });
        }
    });
    const started = new TestResponse();
    await handler(request({ body: { action: 'start', sizeBytes: TEN_MIB, pageCount: 20 } }), started);
    assert.equal(started.statusCode, 200);
    assert.deepEqual(Object.keys(started.json()).sort(), ['fileToken', 'uploadUrl']);
    upload = readUploadToken(started.json().fileToken, OWNER, config());
    for (const [action, expected] of [['status', { ready: true }], ['delete', { deleted: true }]]) {
        const res = new TestResponse();
        await handler(request({ body: { action, fileToken: started.json().fileToken } }), res);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json(), expected);
        assert.equal(res.headers['cache-control'], 'no-store');
    }
    assert.equal(authCalls.length, 3);
    assert.deepEqual(googleCalls.map((call) => call.options.method), ['POST', 'GET', 'DELETE']);
    assert.equal(googleCalls[2].url, `${GOOGLE_API}/v1beta/${upload.name}`);
});

test('upload API rejects unsigned accounts and another allowed-owner configuration before using their file token', async () => {
    const { fileToken } = await uploadFixture();
    let googleCalls = 0;
    for (const options of [
        { env: UPLOAD_ENV, authenticateRequest: testAuthenticator(), headers: { authorization: '' }, status: 401 },
        { env: UPLOAD_ENV, authenticateRequest: testAuthenticator(verifiedPayload({ email: 'stranger@example.test' })), status: 403 },
        { env: { ...UPLOAD_ENV, ALLOWED_GOOGLE_EMAIL: 'second@example.test' }, authenticateRequest: testAuthenticator(verifiedPayload({ email: 'second@example.test' })), status: 400 }
    ]) {
        const res = new TestResponse();
        await createUploadHandler({ ...options, fetchImpl: async () => { googleCalls += 1; } })(request({ body: { action: 'status', fileToken }, headers: options.headers }), res);
        assert.equal(res.statusCode, options.status);
    }
    assert.equal(googleCalls, 0);
});

test('upload API rejects raw file URLs, oversized JSON and unrecognized operations without fetching them', async () => {
    const { fileToken } = await uploadFixture();
    let calls = 0;
    const handler = createUploadHandler({ env: UPLOAD_ENV, authenticateRequest: testAuthenticator(), fetchImpl: async () => { calls += 1; } });
    for (const [body, status] of [
        [{ action: 'status', fileToken: 'https://attacker.example/document.pdf' }, 400],
        [{ action: 'delete', fileUri: `${GOOGLE_API}/v1beta/files/untrusted` }, 400],
        [{ action: 'unknown', fileToken }, 400],
        [{ action: 'start', sizeBytes: TEN_MIB + 1, pageCount: 1 }, 400],
        [{ action: 'start', ignored: 'x'.repeat(2049) }, 413]
    ]) {
        const res = new TestResponse();
        await handler(request({ body }), res);
        assert.equal(res.statusCode, status);
    }
    assert.equal(calls, 0);
});

test('uploaded translation resolves a signed 10 MiB file and keeps page-range and partial-result semantics', async () => {
    const { fileToken, upload } = await uploadFixture();
    let document;
    let lookups = 0;
    const handler = createTranslateHandler({
        env: UPLOAD_ENV,
        authenticateRequest: testAuthenticator(),
        fetchUploadedFile: async (value, runtimeConfig, ignoredFetch, signal) => {
            lookups += 1;
            assert.deepEqual(value, upload);
            assert.equal(signal instanceof AbortSignal, true);
            return getUploadedFile(value, runtimeConfig, async () => Response.json(fileMetadata(upload)));
        },
        translate: async (value) => {
            document = value;
            return { text: 'partial synthetic translation', complete: false, finishReason: 'MAX_TOKENS' };
        }
    });
    const res = new TestResponse();
    await handler(request({ body: { fileToken, targetLanguage: 'zh-CN', startPage: 19, endPage: 24 } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(lookups, 1);
    assert.deepEqual(document, {
        targetLanguage: 'zh-CN', startPage: 19, endPage: 20, pageCount: 20,
        fileUri: `${GOOGLE_API}/v1beta/${upload.name}`
    });
    assert.equal(Object.hasOwn(document, 'pdfBase64'), false);
    assert.deepEqual(res.json(), {
        text: 'partial synthetic translation', complete: false, finishReason: 'MAX_TOKENS',
        startPage: 19, endPage: 20, pageCount: 20, model: config().model
    });
});

test('uploaded translation rejects unknown credentials, raw URLs and invalid page ranges before inference', async () => {
    const { fileToken } = await uploadFixture();
    let lookups = 0;
    let generations = 0;
    const handler = createTranslateHandler({
        env: UPLOAD_ENV, authenticateRequest: testAuthenticator(),
        fetchUploadedFile: async () => { lookups += 1; },
        translate: async () => { generations += 1; }
    });
    for (const body of [
        { fileToken: 'https://attacker.example/document.pdf', targetLanguage: 'en', startPage: 1, endPage: 1 },
        { fileUri: 'https://attacker.example/document.pdf', targetLanguage: 'en', startPage: 1, endPage: 1 },
        { fileToken, targetLanguage: 'en', startPage: 1, endPage: 6 },
        { fileToken, targetLanguage: 'en', startPage: 21, endPage: 21 },
        { fileToken, targetLanguage: 'unsupported', startPage: 1, endPage: 1 }
    ]) {
        const res = new TestResponse();
        await handler(request({ body }), res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(lookups, 0);
    assert.equal(generations, 0);
});

test('uploaded translation waits for ACTIVE file metadata, and deletion treats missing files as cleared', async () => {
    const { fileToken, upload } = await uploadFixture();
    let generations = 0;
    const res = new TestResponse();
    await createTranslateHandler({
        env: UPLOAD_ENV, authenticateRequest: testAuthenticator(),
        fetchUploadedFile: async () => null,
        translate: async () => { generations += 1; }
    })(request({ body: { fileToken, targetLanguage: 'en', startPage: 1, endPage: 1 } }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'UPLOAD_NOT_READY');
    assert.equal(generations, 0);
    await deleteUpload(upload, config(), async () => new Response(null, { status: 404 }));
    await assert.rejects(deleteUpload(upload, config(), async () => new Response(null, { status: 500 })), { status: 502, code: 'UPLOAD_UNAVAILABLE' });
});
