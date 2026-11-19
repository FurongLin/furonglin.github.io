import { getConfig, publicConfig } from '../lib/config.js';
import { sendError, sendJson } from '../lib/errors.js';
import { prepareRequest } from '../lib/http.js';

export function createConfigHandler({ env = process.env } = {}) {
    return async function handler(req, res) {
        try {
            const config = getConfig(env);
            if (prepareRequest(req, res, config, 'GET')) {
                sendJson(res, 200, publicConfig(config));
            }
        } catch (error) {
            sendError(res, error);
        }
    };
}

export default createConfigHandler();
