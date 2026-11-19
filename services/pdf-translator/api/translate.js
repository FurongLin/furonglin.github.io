import { authenticate } from '../lib/auth.js';
import { getConfig } from '../lib/config.js';
import { ApiError, sendError, sendJson } from '../lib/errors.js';
import { translateWithGemini } from '../lib/gemini.js';
import { prepareRequest, readJson } from '../lib/http.js';
import { validateTranslation, validateUploadedSelection } from '../lib/pdf.js';
import { getUploadedFile, readUploadToken } from '../lib/uploads.js';

export function createTranslateHandler({
    env = process.env,
    authenticateRequest = authenticate,
    translate = translateWithGemini,
    fetchUploadedFile = getUploadedFile
} = {}) {
    return async function handler(req, res) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        const onResponseClose = () => {
            if (!res.writableEnded) {
                controller.abort();
            }
        };
        req.once('aborted', onAbort);
        req.once('error', onAbort);
        res.once('close', onResponseClose);
        try {
            const config = getConfig(env);
            if (!prepareRequest(req, res, config, 'POST')) {
                return;
            }
            const owner = await authenticateRequest(req, config);
            if (!config.translationReady) {
                throw new ApiError(503, 'TRANSLATION_NOT_CONFIGURED', 'The private translation service is not configured.');
            }
            const body = await readJson(req);
            let document;
            if (Object.hasOwn(body, 'fileToken')) {
                const upload = readUploadToken(body.fileToken, owner.email, config);
                const selection = validateUploadedSelection(body, upload.pageCount);
                const fileUri = await fetchUploadedFile(upload, config, undefined, controller.signal);
                if (!fileUri) throw new ApiError(409, 'UPLOAD_NOT_READY', 'Wait for the PDF upload and try again.');
                document = { ...selection, fileUri };
            } else {
                document = await validateTranslation(body);
            }
            if (controller.signal.aborted || req.aborted || res.destroyed) {
                return;
            }
            const result = await translate(document, config, { signal: controller.signal });
            sendJson(res, 200, {
                ...result,
                startPage: document.startPage,
                endPage: document.endPage,
                pageCount: document.pageCount,
                model: config.model
            });
        } catch (error) {
            sendError(res, error);
        } finally {
            req.removeListener('aborted', onAbort);
            req.removeListener('error', onAbort);
            res.removeListener('close', onResponseClose);
        }
    };
}

export default createTranslateHandler();
