import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';
import { header, requireAllowedOrigin } from './http.js';

export const SESSION_COOKIE_NAME = '__Host-owner_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=None; Partitioned';
const SESSION_AAD = Buffer.from('furonglin-owner-session-v1');

function sessionKey(config) {
    const secret = config.ownerSessionSecret;
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 ||
        Buffer.byteLength(secret, 'utf8') > 1024) {
        throw new ApiError(503, 'SESSION_NOT_CONFIGURED', 'Persistent sign-in is not configured.');
    }
    return createHash('sha256').update(SESSION_AAD).update(secret, 'utf8').digest();
}

function identityBinding(config) {
    return createHash('sha256').update(JSON.stringify([
        config.googleClientId, config.allowedEmail, config.allowedSub || ''
    ])).digest('base64url');
}

function invalidSession() {
    return new ApiError(401, 'INVALID_SESSION', 'Your sign-in expired or could not be verified.');
}

function decodePart(value) {
    if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw invalidSession();
    }
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) {
        throw invalidSession();
    }
    return bytes;
}

export function createOwnerSession(user, config, { now = () => Date.now() } = {}) {
    const key = sessionKey(config);
    if (!config.signInReady || user.email !== config.allowedEmail) {
        throw invalidSession();
    }
    const iat = Math.floor(now() / 1000);
    const exp = iat + SESSION_MAX_AGE_SECONDS;
    const profile = {
        name: typeof user.name === 'string' ? user.name.slice(0, 160) : '',
        email: user.email,
        exp
    };
    const payload = Buffer.from(JSON.stringify({ v: 1, binding: identityBinding(config), iat, ...profile }));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(SESSION_AAD);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const value = ['s1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    if (value.length > 3500) {
        throw new ApiError(503, 'SESSION_NOT_CONFIGURED', 'Persistent sign-in is not configured.');
    }
    return {
        profile,
        cookie: `${SESSION_COOKIE_NAME}=${value}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Expires=${new Date(exp * 1000).toUTCString()}`
    };
}

export function clearOwnerSessionCookie() {
    return `${SESSION_COOKIE_NAME}=; ${COOKIE_ATTRIBUTES}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function authenticateOwnerSession(req, config, { now = () => Date.now() } = {}) {
    const cookies = header(req, 'cookie').split(';').map((entry) => entry.trim());
    const matching = cookies.filter((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`));
    if (!matching.length) {
        throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in with the allowed Google account.');
    }
    // SameSite=None permits cross-site cookies, so Origin is mandatory for
    // cookie authentication on every endpoint, including session restoration.
    requireAllowedOrigin(req, config);
    const key = sessionKey(config);
    if (matching.length !== 1) {
        throw invalidSession();
    }
    const value = matching[0].slice(SESSION_COOKIE_NAME.length + 1);
    if (value.length > 3500) {
        throw invalidSession();
    }
    try {
        const parts = value.split('.');
        if (parts.length !== 4 || parts[0] !== 's1') {
            throw invalidSession();
        }
        const iv = decodePart(parts[1]);
        const ciphertext = decodePart(parts[2]);
        const tag = decodePart(parts[3]);
        if (iv.length !== 12 || tag.length !== 16) {
            throw invalidSession();
        }
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(SESSION_AAD);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
        const currentTime = Math.floor(now() / 1000);
        if (payload.v !== 1 || payload.binding !== identityBinding(config) ||
            payload.email !== config.allowedEmail || typeof payload.name !== 'string' ||
            payload.name.length > 160 || !Number.isSafeInteger(payload.iat) ||
            !Number.isSafeInteger(payload.exp) || payload.iat < 0 || payload.iat > currentTime + 60 ||
            payload.exp <= currentTime || payload.exp - payload.iat !== SESSION_MAX_AGE_SECONDS) {
            throw invalidSession();
        }
        return { name: payload.name, email: payload.email, exp: payload.exp };
    } catch {
        throw invalidSession();
    }
}
