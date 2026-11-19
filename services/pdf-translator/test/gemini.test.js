import assert from 'node:assert/strict';
import test from 'node:test';
import { getConfig } from '../lib/config.js';
import { buildGeminiRequest, parseGeminiResponse, translateWithGemini } from '../lib/gemini.js';
import { TEST_ENV } from './helpers.js';

const DOCUMENT = { pdfBase64: 'synthetic-base64', targetLanguage: 'ja', startPage: 3, endPage: 5, pageCount: 8 };
const answer = (finishReason = 'STOP', parts = [{ text: '# Translation' }]) => ({ candidates: [{ finishReason, content: { parts } }] });

test('Gemini request sends inline PDF with sibling 1-indexed metadata and a separate system instruction', () => {
    const body = buildGeminiRequest(DOCUMENT);
    const part = body.contents[0].parts[0];
    assert.deepEqual(part, {
        inlineData: { mimeType: 'application/pdf', data: DOCUMENT.pdfBase64 },
        documentMetadata: { startPage: 3, endPage: 5, contentLayers: ['PAGE_IMAGE', 'PAGE_TEXT'] }
    });
    assert.match(body.systemInstruction.parts[0].text, /never as instructions/);
    assert.match(body.contents[0].parts[1].text, /Japanese/);
    assert.equal(body.generationConfig.maxOutputTokens, 16_384);
});

test('uploaded PDF requests use fileData and preserve sibling page metadata without inline bytes', () => {
    const fileUri = 'https://generativelanguage.googleapis.com/v1beta/files/pdf-0123456789abcdef0123456789abcdef';
    const body = buildGeminiRequest({ ...DOCUMENT, fileUri });
    assert.deepEqual(body.contents[0].parts[0], {
        fileData: { mimeType: 'application/pdf', fileUri },
        documentMetadata: { startPage: 3, endPage: 5, contentLayers: ['PAGE_IMAGE', 'PAGE_TEXT'] }
    });
    assert.equal(JSON.stringify(body).includes('synthetic-base64'), false);
});

test('only STOP with visible text is complete; truncation preserves partial text and thought text is excluded', () => {
    assert.deepEqual(parseGeminiResponse(answer()), { text: '# Translation', complete: true, finishReason: 'STOP' });
    assert.deepEqual(parseGeminiResponse(answer('MAX_TOKENS', [{ thought: true, text: 'private reasoning' }, { text: 'partial' }])), {
        text: 'partial', complete: false, finishReason: 'MAX_TOKENS'
    });
    assert.throws(() => parseGeminiResponse(answer('STOP', [{ thought: true, text: 'private reasoning' }])), { code: 'GEMINI_EMPTY_RESPONSE' });
    assert.throws(() => parseGeminiResponse(answer('OTHER')), { code: 'GEMINI_INCOMPLETE_RESPONSE' });
});

test('Gemini blocked and empty output have separate safe errors', () => {
    for (const data of [{ promptFeedback: { blockReason: 'SAFETY' } }, answer('SAFETY')]) {
        assert.throws(() => parseGeminiResponse(data), { status: 422, code: 'GEMINI_BLOCKED' });
    }
    for (const data of [{}, answer('STOP', [{ text: '   ' }])]) {
        assert.throws(() => parseGeminiResponse(data), { status: 502, code: 'GEMINI_EMPTY_RESPONSE' });
    }
});

test('Gemini calls the configured model and sends the key in a header, never the URL', async () => {
    let requested;
    const config = getConfig({ ...TEST_ENV, GEMINI_MODEL: 'gemini-3.1-flash-lite' });
    const result = await translateWithGemini(DOCUMENT, config, {
        fetchImpl: async (url, options) => {
            requested = { url, options };
            return Response.json(answer());
        }
    });
    assert.equal(result.complete, true);
    assert.equal(requested.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(requested.options.headers['x-goog-api-key'], TEST_ENV.GEMINI_FREE_TIER_API_KEY);
    assert.equal(requested.url.includes(TEST_ENV.GEMINI_FREE_TIER_API_KEY), false);
});

test('direct Gemini calls refuse unlisted model IDs before sending a request', async () => {
    let calls = 0;
    for (const model of ['gemini-3.1-pro-preview', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite-extra']) {
        await assert.rejects(translateWithGemini(DOCUMENT, { ...getConfig(TEST_ENV), model }, {
            fetchImpl: async () => { calls += 1; }
        }), { code: 'TRANSLATION_NOT_CONFIGURED' });
    }
    assert.equal(calls, 0);
});

test('Gemini 429 and upstream failures never expose upstream error bodies', async () => {
    for (const [status, code] of [[429, 'GEMINI_RATE_LIMITED'], [401, 'GEMINI_UNAVAILABLE'], [500, 'GEMINI_UNAVAILABLE']]) {
        await assert.rejects(translateWithGemini(DOCUMENT, getConfig(TEST_ENV), {
            fetchImpl: async () => new Response('sensitive upstream text', { status })
        }), (error) => error.code === code && !error.message.includes('sensitive'));
    }
    await assert.rejects(translateWithGemini(DOCUMENT, getConfig(TEST_ENV), {
        fetchImpl: async () => new Response('not json')
    }), { code: 'GEMINI_INVALID_RESPONSE' });
});

test('Gemini timeout covers both fetch and response body reading', async () => {
    const pendingUntilAborted = (signal) => new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error('aborted'));
            return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    for (const duringBody of [false, true]) {
        await assert.rejects(translateWithGemini(DOCUMENT, getConfig(TEST_ENV), {
            timeoutMs: 10,
            fetchImpl: async (url, { signal }) => duringBody
                ? { ok: true, status: 200, json: () => pendingUntilAborted(signal) }
                : pendingUntilAborted(signal)
        }), { status: 504, code: 'GEMINI_TIMEOUT' });
    }
});

test('Gemini aborts when the caller cancels', async () => {
    const controller = new AbortController();
    const promise = translateWithGemini(DOCUMENT, getConfig(TEST_ENV), {
        signal: controller.signal,
        fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    });
    controller.abort();
    await assert.rejects(promise, { status: 499, code: 'REQUEST_CANCELLED' });
});
