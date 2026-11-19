import { OAuth2Client } from 'google-auth-library';
import { normalizeEmail } from './config.js';
import { ApiError } from './errors.js';
import { header } from './http.js';
import { authenticateOwnerSession } from './session.js';

const googleClient = new OAuth2Client();

export function createAuthenticator({
    verifyIdToken = (options) => googleClient.verifyIdToken(options),
    now = () => Date.now()
} = {}) {
    return async function authenticate(req, config) {
        if (!config.signInReady) {
            throw new ApiError(503, 'SIGN_IN_NOT_CONFIGURED', 'Private Google sign-in is not configured.');
        }
        const authorization = header(req, 'authorization');
        if (!authorization && (req.headers?.authorization === undefined || typeof req.headers.authorization === 'string')) {
            return authenticateOwnerSession(req, config, { now });
        }
        const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(authorization);
        if (!match || match[1].length > 16_384) {
            throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in with the allowed Google account.');
        }
        let payload;
        try {
            // Google verifies signature, issuer, audience and expiry. Never decode
            // a JWT as a substitute, and never accept a client-supplied email.
            const ticket = await verifyIdToken({
                idToken: match[1],
                audience: config.googleClientId
            });
            payload = ticket.getPayload();
        } catch {
            throw new ApiError(401, 'INVALID_ID_TOKEN', 'Google sign-in expired or could not be verified.');
        }
        if (!payload || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(now() / 1000)) {
            throw new ApiError(401, 'INVALID_ID_TOKEN', 'Google sign-in expired or could not be verified.');
        }
        const email = normalizeEmail(payload.email);
        if (payload.email_verified !== true || email !== config.allowedEmail ||
            (config.allowedSub && payload.sub !== config.allowedSub)) {
            throw new ApiError(403, 'ACCOUNT_NOT_ALLOWED', 'This Google account is not allowed.');
        }
        return {
            name: typeof payload.name === 'string' ? payload.name : '',
            email,
            exp: payload.exp
        };
    };
}

export const authenticate = createAuthenticator();
