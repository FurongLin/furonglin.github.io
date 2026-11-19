export class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function sendJson(res, status, data) {
    if (res.destroyed || res.writableEnded) {
        return;
    }
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
}

export function sendError(res, error) {
    const safeError = error instanceof ApiError
        ? error
        : new ApiError(500, 'INTERNAL_ERROR', 'The request could not be completed.');
    sendJson(res, safeError.status, {
        error: {
            code: safeError.code,
            message: safeError.message
        }
    });
}
