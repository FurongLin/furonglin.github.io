import { PDFDocument, EncryptedPDFError } from 'pdf-lib';
import { MAX_DOCUMENT_PAGES, MAX_PAGES_PER_BATCH, MAX_PDF_BYTES } from './config.js';
import { ApiError } from './errors.js';

// pdf-lib's transpiled Error subclass may not preserve instanceof on Node.
const ENCRYPTED_PDF_MESSAGE = new EncryptedPDFError().message;

export const TARGET_LANGUAGES = Object.freeze({
    'zh-CN': 'Simplified Chinese',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    fr: 'French',
    de: 'German',
    es: 'Spanish'
});

function readSelection({ targetLanguage, startPage, endPage }) {
    if (!Object.hasOwn(TARGET_LANGUAGES, targetLanguage)) {
        throw new ApiError(400, 'INVALID_LANGUAGE', 'Choose a supported target language.');
    }
    if (!Number.isSafeInteger(startPage) || !Number.isSafeInteger(endPage) || startPage < 1 || endPage < startPage) {
        throw new ApiError(400, 'INVALID_PAGE_RANGE', 'Use a valid inclusive page range starting at page 1.');
    }
    return { targetLanguage, startPage, endPage };
}

function clampSelection({ targetLanguage, startPage, endPage }, pageCount) {
    const clampedEndPage = Math.min(endPage, pageCount);
    if (startPage > pageCount || clampedEndPage - startPage + 1 > MAX_PAGES_PER_BATCH) {
        throw new ApiError(400, 'INVALID_PAGE_RANGE', 'Translate at most 5 existing PDF pages per request.');
    }
    return { targetLanguage, startPage, endPage: clampedEndPage, pageCount };
}

export function validateUploadedSelection(body, pageCount) {
    return clampSelection(readSelection(body), pageCount);
}

export async function validateTranslation(body) {
    const selection = readSelection(body);
    const { pdfBase64 } = body;
    if (typeof pdfBase64 !== 'string' || !pdfBase64) {
        throw new ApiError(400, 'INVALID_PDF_ENCODING', 'Send canonical PDF base64 without a data URL.');
    }
    if (pdfBase64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4) {
        throw new ApiError(413, 'PDF_TOO_LARGE', 'Choose a PDF no larger than 2 MiB.');
    }
    const paddingStart = pdfBase64.indexOf('=');
    if (pdfBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(pdfBase64) ||
        (paddingStart !== -1 && !/^={1,2}$/.test(pdfBase64.slice(paddingStart)))) {
        throw new ApiError(400, 'INVALID_PDF_ENCODING', 'Send canonical PDF base64 without a data URL.');
    }
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    if (pdfBytes.toString('base64') !== pdfBase64) {
        throw new ApiError(400, 'INVALID_PDF_ENCODING', 'Send canonical PDF base64 without a data URL.');
    }
    if (pdfBytes.length > MAX_PDF_BYTES) {
        throw new ApiError(413, 'PDF_TOO_LARGE', 'Choose a PDF no larger than 2 MiB.');
    }
    if (pdfBytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new ApiError(400, 'INVALID_PDF', 'The file must be a valid PDF.');
    }
    let pageCount;
    try {
        const document = await PDFDocument.load(pdfBytes, { ignoreEncryption: false, throwOnInvalidObject: true });
        pageCount = document.getPageCount();
    } catch (error) {
        if (error instanceof EncryptedPDFError || error?.message === ENCRYPTED_PDF_MESSAGE) {
            throw new ApiError(400, 'ENCRYPTED_PDF', 'Password-protected or encrypted PDFs are not supported.');
        }
        throw new ApiError(400, 'INVALID_PDF', 'The PDF is damaged or cannot be read.');
    }
    if (pageCount < 1) {
        throw new ApiError(400, 'INVALID_PDF', 'The PDF must contain at least one page.');
    }
    if (pageCount > MAX_DOCUMENT_PAGES) {
        throw new ApiError(400, 'TOO_MANY_PAGES', 'Choose a PDF with no more than 100 pages.');
    }
    return { pdfBase64, ...clampSelection(selection, pageCount) };
}
