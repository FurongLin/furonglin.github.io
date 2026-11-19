import { authenticate } from '../lib/auth.js';
import { getConfig } from '../lib/config.js';
import { ApiError, sendError, sendJson } from '../lib/errors.js';
import { translateWithGemini } from '../lib/gemini.js';
import { prepareRequest, readJson } from '../lib/http.js';
import { validateTranslation } from '../lib/pdf.js';

export function createTranslateHandler({
    env = process.env,
    authenticateRequest = authenticate,
    translate = translateWithGemini
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
            await authenticateRequest(req, config);
            if (!config.translationReady) {
                throw new ApiError(503, 'TRANSLATION_NOT_CONFIGURED', 'The private translation service is not configured.');
            }
            const body = await readJson(req);
            const document = await validateTranslation(body);
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
