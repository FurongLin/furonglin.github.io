import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import { createAuthenticator } from '../lib/auth.js';

// Deliberately synthetic values; these are not verified Google credentials.
export const TEST_ENV = Object.freeze({
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    ALLOWED_GOOGLE_EMAIL: 'owner@example.test',
    GEMINI_FREE_TIER_API_KEY: 'synthetic-test-key'
});

export function verifiedPayload(overrides = {}) {
    return {
        email: 'owner@example.test',
        email_verified: true,
        sub: 'synthetic-owner-subject',
        exp: Math.floor(Date.now() / 1000) + 3600,
        name: 'Test Owner',
        ...overrides
    };
}

export function testAuthenticator(payload = verifiedPayload(), calls = []) {
    return createAuthenticator({
        verifyIdToken: async (options) => {
            calls.push(options);
            return { getPayload: () => payload };
        }
    });
}

export function request({ body, raw, chunks, method = 'POST', headers = {} } = {}) {
    const source = chunks || [raw ?? (body === undefined ? '' : JSON.stringify(body))];
    const req = Readable.from(source);
    req.method = method;
    req.headers = {
        authorization: 'Bearer synthetic.test.token',
        'content-type': 'application/json',
        ...headers
    };
    return req;
}

export class TestResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = {};
        this.statusCode = 200;
        this.writableEnded = false;
        this.destroyed = false;
    }

    setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
    }

    end(body = '') {
        this.body = body;
        this.writableEnded = true;
        this.emit('finish');
    }

    json() {
        return JSON.parse(this.body);
    }
}

export async function makePdf(pages = 2) {
    const document = await PDFDocument.create();
    for (let index = 0; index < pages; index += 1) {
        document.addPage([200, 200]);
    }
    return Buffer.from(await document.save({ addDefaultPage: false })).toString('base64');
}

export async function translationBody(pages = 2, overrides = {}) {
    return {
        pdfBase64: await makePdf(pages),
        targetLanguage: 'zh-CN',
        startPage: 1,
        endPage: 5,
        ...overrides
    };
}
