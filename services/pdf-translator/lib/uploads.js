import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MAX_DOCUMENT_PAGES, MAX_PDF_BYTES, MAX_UPLOAD_BYTES } from './config.js';
import { ApiError } from './errors.js';

const GOOGLE_API = 'https://generativelanguage.googleapis.com';
const UPLOAD_PATH = '/upload/v1beta/files';
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const PDF_TYPE = 'application/pdf';

function validDocument(sizeBytes, pageCount) {
    return Number.isInteger(sizeBytes) && sizeBytes > MAX_PDF_BYTES && sizeBytes <= MAX_UPLOAD_BYTES &&
        Number.isInteger(pageCount) && pageCount >= 1 && pageCount <= MAX_DOCUMENT_PAGES;
}

function sign(payload, email, config) {
    if (config.ownerSessionSecret.length < 32) {
        throw new ApiError(503, 'SERVICE_NOT_CONFIGURED', 'Large PDF uploads are not configured.');
    }
    return createHmac('sha256', config.ownerSessionSecret)
        .update('pdf-upload-v1\0').update(email).update('\0').update(payload).digest();
}

export function readUploadToken(token, email, config) {
    const invalid = new ApiError(400, 'INVALID_UPLOAD', 'The PDF upload expired or could not be verified. Upload it again.');
    if (typeof token !== 'string' || !/^[\w-]{1,300}\.[\w-]{43}$/.test(token)) throw invalid;
    const [payload, signature] = token.split('.');
    const signatureBytes = Buffer.from(signature, 'base64url');
    if (signatureBytes.toString('base64url') !== signature || !timingSafeEqual(sign(payload, email, config), signatureBytes)) throw invalid;
    let upload;
    try {
        upload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        throw invalid;
    }
    if (!/^files\/pdf-[a-f0-9]{32}$/.test(upload?.name) ||
        !Number.isSafeInteger(upload.exp) || upload.exp <= Date.now() ||
        !validDocument(upload.sizeBytes, upload.pageCount)) throw invalid;
    return upload;
}

function googleUploadUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new ApiError(502, 'UPLOAD_UNAVAILABLE', 'Google could not start this PDF upload.');
    }
    if (url.origin !== GOOGLE_API || url.pathname !== UPLOAD_PATH || url.username || url.password || url.hash ||
        [...url.searchParams.keys()].sort().join(',') !== 'upload_id,upload_protocol' ||
        url.searchParams.get('upload_protocol') !== 'resumable' || !url.searchParams.get('upload_id')) {
        throw new ApiError(502, 'UPLOAD_UNAVAILABLE', 'Google could not start this PDF upload.');
    }
    return url.href;
}

function googleFileUrl(upload) {
    return `${GOOGLE_API}/v1beta/${upload.name}`;
}

async function googleRequest(url, config, options, fetchImpl, signal) {
    const timeout = AbortSignal.timeout(15_000);
    try {
        const response = await fetchImpl(url, {
            ...options,
            redirect: 'error',
            headers: { ...options.headers, 'x-goog-api-key': config.geminiApiKey },
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        });
        if (response.status === 429) {
            throw new ApiError(429, 'GEMINI_RATE_LIMITED', 'Gemini quota or rate limit reached. Wait before trying again.');
        }
        return response;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, 'UPLOAD_UNAVAILABLE', 'Google could not process this PDF upload.');
    }
}

export async function startUpload({ sizeBytes, pageCount }, email, config, fetchImpl = fetch) {
    if (!validDocument(sizeBytes, pageCount)) {
        throw new ApiError(400, 'INVALID_UPLOAD', 'Choose a PDF within the upload and page limits.');
    }
    const name = `files/pdf-${randomBytes(16).toString('hex')}`;
    const payload = Buffer.from(JSON.stringify({ name, sizeBytes, pageCount, exp: Date.now() + UPLOAD_TTL_MS })).toString('base64url');
    const fileToken = `${payload}.${sign(payload, email, config).toString('base64url')}`;
    const response = await googleRequest(GOOGLE_API + UPLOAD_PATH, config, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(sizeBytes),
            'X-Goog-Upload-Header-Content-Type': PDF_TYPE
        },
        body: JSON.stringify({ file: { name } })
    }, fetchImpl);
    if (!response.ok) throw new ApiError(502, 'UPLOAD_UNAVAILABLE', 'Google could not start this PDF upload.');
    return { fileToken, uploadUrl: googleUploadUrl(response.headers.get('x-goog-upload-url')) };
}

export async function getUploadedFile(upload, config, fetchImpl = fetch, signal) {
    const url = googleFileUrl(upload);
    const response = await googleRequest(url, config, { method: 'GET' }, fetchImpl, signal);
    // Gemini also returns 403 for a named file that has yet to be created.
    if (response.status === 403 || response.status === 404) return null;
    const file = response.ok ? await response.json().catch(() => null) : null;
    if (!file || file.name !== upload.name || file.mimeType !== PDF_TYPE || Number(file.sizeBytes) !== upload.sizeBytes) {
        throw new ApiError(502, 'UPLOAD_UNAVAILABLE', 'Google could not verify this PDF upload.');
    }
    if (file.state === 'PROCESSING') return null;
    if (file.state !== 'ACTIVE') throw new ApiError(422, 'INVALID_PDF', 'Google could not read this PDF.');
    return url;
}

export async function deleteUpload(upload, config, fetchImpl = fetch) {
    const response = await googleRequest(googleFileUrl(upload), config, { method: 'DELETE' }, fetchImpl);
    if (!response.ok && response.status !== 404) {
        throw new ApiError(502, 'UPLOAD_UNAVAILABLE', 'Google could not clear this PDF upload.');
    }
}
