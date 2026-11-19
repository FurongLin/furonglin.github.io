import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { MAX_PDF_BYTES } from '../lib/config.js';
import { validateTranslation } from '../lib/pdf.js';
import { makePdf, translationBody } from './helpers.js';

test('PDF validation clamps inclusive end page and preserves the full original PDF', async () => {
    const body = await translationBody(3, { startPage: 2, endPage: 500 });
    const parsed = await validateTranslation(body);
    assert.equal(parsed.endPage, 3);
    assert.equal(parsed.startPage, 2);
    assert.equal(parsed.pageCount, 3);
    assert.equal(parsed.pdfBase64, body.pdfBase64);
});

test('PDF validation rejects invalid ranges, batches and unsupported target languages', async () => {
    const body = await translationBody(7);
    for (const overrides of [
        { startPage: 0 }, { startPage: 8, endPage: 9 }, { startPage: 2, endPage: 1 },
        { endPage: 6 }, { startPage: '1' }, { endPage: 1.5 }, { endPage: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
        await assert.rejects(validateTranslation({ ...body, ...overrides }), { status: 400, code: 'INVALID_PAGE_RANGE' });
    }
    for (const targetLanguage of ['pt', '__proto__', '', null]) {
        await assert.rejects(validateTranslation({ ...body, targetLanguage }), { status: 400, code: 'INVALID_LANGUAGE' });
    }
    for (const targetLanguage of ['zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es']) {
        await validateTranslation({ ...body, targetLanguage });
    }
});

test('PDF validation rejects noncanonical base64, data URLs and false PDF files', async () => {
    const body = await translationBody();
    for (const pdfBase64 of ['', body.pdfBase64 + '\n', 'data:application/pdf;base64,' + body.pdfBase64, 'AAAA-A==', 'A===', 'YR==']) {
        await assert.rejects(validateTranslation({ ...body, pdfBase64 }), { status: 400, code: 'INVALID_PDF_ENCODING' });
    }
    for (const text of [
        'not a pdf',
        '%PDF-1.7\ncorrupt',
        '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
    ]) {
        await assert.rejects(validateTranslation({ ...body, pdfBase64: Buffer.from(text).toString('base64') }), { status: 400, code: 'INVALID_PDF' });
    }
});

test('PDF validation handles a near-limit input without recursive base64 regex overflow', async () => {
    const body = await translationBody();
    const bytes = Buffer.alloc(MAX_PDF_BYTES, 65);
    await assert.rejects(validateTranslation({ ...body, pdfBase64: bytes.toString('base64') }), { status: 400, code: 'INVALID_PDF' });
    await assert.rejects(validateTranslation({ ...body, pdfBase64: Buffer.alloc(MAX_PDF_BYTES + 1).toString('base64') }), { status: 413, code: 'PDF_TOO_LARGE' });
});

test('PDF validation rejects more than 100 pages, empty documents and encrypted documents', async () => {
    const body = await translationBody();
    await assert.rejects(validateTranslation({ ...body, pdfBase64: await makePdf(101) }), { status: 400, code: 'TOO_MANY_PAGES' });
    await assert.rejects(validateTranslation({ ...body, pdfBase64: await makePdf(0) }), { status: 400, code: 'INVALID_PDF' });
    const encrypted = await PDFDocument.create();
    encrypted.addPage();
    // A synthetic encryption dictionary exercises pdf-lib's real encrypted-PDF detection.
    encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({
        Filter: PDFName.of('Standard'), V: 1, R: 2, O: PDFString.of('synthetic'), U: PDFString.of('synthetic'), P: -4
    }));
    const pdfBase64 = Buffer.from(await encrypted.save()).toString('base64');
    await assert.rejects(validateTranslation({ ...body, pdfBase64 }), { status: 400, code: 'ENCRYPTED_PDF' });
});
