import { authenticate } from '../lib/auth.js';
import { getConfig } from '../lib/config.js';
import { sendError, sendJson } from '../lib/errors.js';
import { prepareRequest } from '../lib/http.js';

export function createSessionHandler({ env = process.env, authenticateRequest = authenticate } = {}) {
    return async function handler(req, res) {
        try {
            const config = getConfig(env);
            if (!prepareRequest(req, res, config, 'POST')) {
                return;
            }
            const user = await authenticateRequest(req, config);
            sendJson(res, 200, user);
        } catch (error) {
            sendError(res, error);
        }
    };
}

export default createSessionHandler();
