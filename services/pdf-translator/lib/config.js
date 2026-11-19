export const MAX_PDF_BYTES = 2 * 1024 * 1024;
export const MAX_BODY_BYTES = 3 * 1024 * 1024;
export const MAX_PAGES_PER_BATCH = 5;
export const MAX_DOCUMENT_PAGES = 100;
export const GEMINI_TIMEOUT_MS = 240_000;
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

// Check Google's pricing before adding a model. The key must also belong to
// an unbilled Gemini project, since a model ID does not select a billing tier.
const FREE_TIER_PDF_MODELS = new Set([DEFAULT_MODEL, 'gemini-3.1-flash-lite']);

export function isFreeTierPdfModel(model) {
    return FREE_TIER_PDF_MODELS.has(model);
}

const DEFAULT_ORIGINS = [
    'https://furonglin.github.io',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
];

export function normalizeEmail(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function getConfig(env = process.env) {
    const googleClientId = (env.GOOGLE_CLIENT_ID || '').trim();
    const allowedEmail = normalizeEmail(env.ALLOWED_GOOGLE_EMAIL);
    const allowedSub = (env.ALLOWED_GOOGLE_SUB || '').trim();
    const geminiApiKey = (env.GEMINI_FREE_TIER_API_KEY || '').trim();
    const model = (env.GEMINI_MODEL || DEFAULT_MODEL).trim();
    const signInReady = Boolean(googleClientId && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail));
    const configuredOrigins = env.ALLOWED_ORIGINS === undefined
        ? DEFAULT_ORIGINS
        : env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
    const allowedOrigins = configuredOrigins.filter((origin) => {
        try {
            const parsed = new URL(origin);
            return ['https:', 'http:'].includes(parsed.protocol) && parsed.origin === origin;
        } catch {
            return false;
        }
    });

    return {
        googleClientId,
        allowedEmail,
        allowedSub,
        geminiApiKey,
        model,
        signInReady,
        translationReady: signInReady && Boolean(geminiApiKey) && isFreeTierPdfModel(model),
        allowedOrigins
    };
}

export function publicConfig(config) {
    return {
        googleClientId: config.googleClientId,
        maxPdfBytes: MAX_PDF_BYTES,
        maxPagesPerBatch: MAX_PAGES_PER_BATCH,
        maxDocumentPages: MAX_DOCUMENT_PAGES,
        signInReady: config.signInReady,
        translationReady: config.translationReady
    };
}
