import { createServer } from 'node:http';
import configHandler from './api/config.js';
import sessionHandler from './api/session.js';
import translateHandler from './api/translate.js';

const handlers = new Map([
    ['/api/config', configHandler],
    ['/api/session', sessionHandler],
    ['/api/translate', translateHandler]
]);

createServer((req, res) => {
    const handler = handlers.get(new URL(req.url, 'http://localhost').pathname);
    if (!handler) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        res.end();
        return;
    }
    handler(req, res);
}).listen(8787, '127.0.0.1', () => {
    console.log('Private translator API: http://127.0.0.1:8787/api/config');
});
