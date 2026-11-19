import { MAX_BODY_BYTES } from './config.js';
import { ApiError } from './errors.js';

export function header(req, name) {
    const value = req.headers?.[name.toLowerCase()];
    return typeof value === 'string' ? value : '';
}

export function requireAllowedOrigin(req, config) {
    const origin = header(req, 'origin');
    if (!origin || !config.allowedOrigins.includes(origin)) {
        throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed.');
    }
    return origin;
}

export function prepareRequest(req, res, config, method) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin');

    const origin = header(req, 'origin');
    if ((req.headers?.origin !== undefined && !origin) || (origin && !config.allowedOrigins.includes(origin))) {
        throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed.');
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', `${method}, OPTIONS`);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    if (req.method === 'OPTIONS') {
        const requestedMethod = header(req, 'access-control-request-method');
        if (requestedMethod && requestedMethod !== method) {
            throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This method is not allowed.');
        }
        res.statusCode = 204;
        res.end();
        return false;
    }
    if (req.method !== method) {
        res.setHeader('Allow', `${method}, OPTIONS`);
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'This method is not allowed.');
    }
    return true;
}

export async function readJson(req, maxBytes = MAX_BODY_BYTES, { allowEmpty = false } = {}) {
    if (!/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type'))) {
        throw new ApiError(415, 'JSON_REQUIRED', 'Send an application/json request.');
    }
    if (header(req, 'content-encoding') && header(req, 'content-encoding').toLowerCase() !== 'identity') {
        throw new ApiError(415, 'CONTENT_ENCODING_NOT_ALLOWED', 'Compressed request bodies are not supported.');
    }
    const contentLength = header(req, 'content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
        throw new ApiError(413, 'BODY_TOO_LARGE', 'The JSON request exceeds the size limit.');
    }
    const chunks = [];
    let size = 0;
    try {
        // Do not access Vercel's lazy req.body helper: bound the original bytes.
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > maxBytes) {
                throw new ApiError(413, 'BODY_TOO_LARGE', 'The JSON request exceeds the size limit.');
            }
            chunks.push(buffer);
        }
    } catch (error) {
        if (error instanceof ApiError) {
            req.resume();
            throw error;
        }
        throw new ApiError(400, 'INVALID_BODY', 'The request body could not be read.');
    }
    let body;
    if (allowEmpty && size === 0) {
        return {};
    }
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
        body = JSON.parse(text);
    } catch {
        throw new ApiError(400, 'INVALID_JSON', 'The request must contain valid UTF-8 JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'INVALID_JSON', 'The request must contain a JSON object.');
    }
    return body;
}
