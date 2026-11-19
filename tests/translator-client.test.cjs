const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../assets/pdf-translator.js');

test('only fixed HTTPS API origins or local development origins are accepted', () => {
    assert.equal(client.normaliseApiBase('https://owner-api.vercel.app/'), 'https://owner-api.vercel.app');
    assert.equal(client.normaliseApiBase('http://localhost:8787'), 'http://localhost:8787');
    for (const value of ['http://evil.example', 'https://user:secret@example.com', 'https://example.com/?token=x', 'javascript:alert(1)', 'https://example.com/path', '']) {
        assert.throws(() => client.normaliseApiBase(value));
    }
});

test('all-page mode and inclusive ranges make bounded translation steps', () => {
    assert.deepEqual(client.validateSelection('all', '', '', 2), { start: 1, end: Infinity, batchSize: 2 });
    assert.deepEqual(client.validateSelection('range', '3', '9', '5'), { start: 3, end: 9, batchSize: 5 });
    for (const values of [['range', 0, 3, 2], ['range', 4, 3, 2], ['range', 1.1, 3, 2], ['range', 1, 101, 2], ['all', 1, 5, 6], ['other', 1, 5, 2]]) {
        assert.throws(() => client.validateSelection(...values));
    }
});

test('PDF signature checking rejects renamed HTML files', () => {
    assert.equal(client.isPdfHeader(new TextEncoder().encode('%PDF-1.7\n')), true);
    assert.equal(client.isPdfHeader(new TextEncoder().encode('<html>not a PDF</html>')), false);
    assert.equal(client.isPdfHeader(new TextEncoder().encode('<!doctype html><!-- %PDF- --><script>bad()</script>')), false);
});

test('preview always uses a PDF MIME type, independently of the original file type', async () => {
    const source = new Blob(['%PDF-1.7\nfixture'], { type: 'text/html' });
    const preview = client.makePreviewBlob(source);
    assert.equal(preview.type, 'application/pdf');
    assert.equal(await preview.text(), await source.text());
});

test('embedded PDF preview has no script or same-origin sandbox capabilities', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../account/index.html'), 'utf8');
    const preview = html.match(/<iframe\b[^>]*id="pdf-preview"[^>]*>/)?.[0];
    assert.ok(preview);
    assert.match(preview, /sandbox=""/);
    assert.doesNotMatch(preview, /allow-scripts|allow-same-origin/);
});

test('partial results use a distinct, safe filename', () => {
    assert.equal(client.downloadName('my/paper.pdf', 'zh-CN', false), 'my_paper.zh-CN.partial.md');
    assert.equal(client.downloadName('paper.pdf', 'en', true), 'paper.en.md');
    assert.equal(client.downloadName('bad\nname.pdf', 'en', true), 'bad_name.en.md');
});

test('completed and partial chunks keep their page references and raw text', () => {
    const chunks = [{startPage: 1, endPage: 2, text: '# Translation\n\n<script>literal</script>'}];
    assert.match(client.combineChunks(chunks, 'zh-CN'), /第 1–2 页/);
    assert.match(client.combineChunks(chunks, 'en'), /Pages 1–2/);
    assert.match(client.combineChunks(chunks, 'en'), /<script>literal<\/script>/);
});
