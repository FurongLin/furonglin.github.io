import { authenticate } from '../lib/auth.js';
import { getConfig } from '../lib/config.js';
import { ApiError, sendError, sendJson } from '../lib/errors.js';
import { header, prepareRequest, readJson, requireAllowedOrigin } from '../lib/http.js';
import { clearOwnerSessionCookie, createOwnerSession } from '../lib/session.js';

export function createSessionHandler({ env = process.env, authenticateRequest = authenticate } = {}) {
    return async function handler(req, res) {
        try {
            const config = getConfig(env);
            if (!prepareRequest(req, res, config, 'POST')) {
                return;
            }
            const hasBody = header(req, 'content-type') || header(req, 'content-length') || header(req, 'transfer-encoding');
            const body = hasBody ? await readJson(req, 1024, { allowEmpty: true }) : {};
            if (body.action === 'signout') {
                requireAllowedOrigin(req, config);
                res.setHeader('Set-Cookie', clearOwnerSessionCookie());
                sendJson(res, 200, { signedOut: true });
                return;
            }
            if (Object.hasOwn(body, 'action')) {
                throw new ApiError(400, 'INVALID_SESSION_ACTION', 'This session action is not supported.');
            }
            const user = await authenticateRequest(req, config);
            if (header(req, 'authorization')) {
                const session = createOwnerSession(user, config);
                res.setHeader('Set-Cookie', session.cookie);
                sendJson(res, 200, session.profile);
            } else {
                sendJson(res, 200, user);
            }
        } catch (error) {
            sendError(res, error);
        }
    };
}

export default createSessionHandler();
