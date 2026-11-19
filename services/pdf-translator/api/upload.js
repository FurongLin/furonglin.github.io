import { authenticate } from '../lib/auth.js';
import { getConfig } from '../lib/config.js';
import { ApiError, sendError, sendJson } from '../lib/errors.js';
import { prepareRequest, readJson } from '../lib/http.js';
import { deleteUpload, getUploadedFile, readUploadToken, startUpload } from '../lib/uploads.js';

export function createUploadHandler({ env = process.env, authenticateRequest = authenticate, fetchImpl = fetch } = {}) {
    return async function handler(req, res) {
        try {
            const config = getConfig(env);
            if (!prepareRequest(req, res, config, 'POST')) return;
            const owner = await authenticateRequest(req, config);
            if (!config.translationReady) {
                throw new ApiError(503, 'TRANSLATION_NOT_CONFIGURED', 'The private translation service is not configured.');
            }
            const body = await readJson(req, 2048);
            if (body.action === 'start') {
                sendJson(res, 200, await startUpload(body, owner.email, config, fetchImpl));
                return;
            }
            const upload = readUploadToken(body.fileToken, owner.email, config);
            if (body.action === 'status') {
                sendJson(res, 200, { ready: Boolean(await getUploadedFile(upload, config, fetchImpl)) });
                return;
            }
            if (body.action === 'delete') {
                await deleteUpload(upload, config, fetchImpl);
                sendJson(res, 200, { deleted: true });
                return;
            }
            throw new ApiError(400, 'INVALID_UPLOAD', 'Choose a valid PDF upload operation.');
        } catch (error) {
            sendError(res, error);
        }
    };
}

export default createUploadHandler();
