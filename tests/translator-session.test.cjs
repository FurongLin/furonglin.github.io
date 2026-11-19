const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/pdf-translator.js'), 'utf8');
const instant = Date.UTC(2026, 10, 19);
const owner = { name: 'Owner', email: 'owner@example.test', exp: instant / 1000 + 30 * 86400 };
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const unsigned = () => reply({ error: { code: 'AUTH_REQUIRED' } }, 401);
const flush = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(setImmediate); };

function harness(session) {
    const calls = [];
    const timers = new Map();
    const windowEvents = new Map();
    const documentEvents = new Map();
    const elements = new Map();
    const clock = { now: instant };
    const google = { loads: 0, buttons: 0, callback: null };
    let timerId = 0;

    function element() {
        const events = new Map();
        return {
            hidden: false, disabled: false, value: '', checked: false, textContent: '', dataset: {}, files: [],
            classList: { toggle() {} },
            addEventListener(type, handler) { events.set(type, handler); },
            emit(type, event = {}) { return events.get(type)?.({ target: this, preventDefault() {}, ...event }); },
            removeAttribute(name) { delete this[name]; },
            replaceChildren(...children) { this.children = children; },
            append() {}, remove() {},
            getBoundingClientRect() { return { width: 260 }; }
        };
    }

    const byId = id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    };
    byId('page-mode').value = 'range';
    byId('page-start').value = '1';
    byId('page-end').value = '1';
    byId('batch-size').value = '1';
    byId('target-language').value = 'zh-CN';

    const window = {
        PDF_TRANSLATOR_CONFIG: { apiBaseUrl: 'https://owner-api.example.test' },
        addEventListener(type, handler) { windowEvents.set(type, handler); }
    };
    const document = {
        readyState: 'complete', visibilityState: 'visible',
        documentElement: { lang: 'en' },
        getElementById: byId,
        createElement: element,
        createDocumentFragment: element,
        createTextNode: text => ({ textContent: text }),
        addEventListener(type, handler) { documentEvents.set(type, handler); },
        head: { append(script) {
            google.loads++;
            queueMicrotask(() => {
                window.google = { accounts: { id: {
                    initialize(options) { google.callback = options.callback; },
                    renderButton() { google.buttons++; },
                    disableAutoSelect() {}
                } } };
                script.onload();
            });
        } }
    };
    class BrowserURL extends URL {}
    BrowserURL.createObjectURL = () => 'blob:local-document';
    BrowserURL.revokeObjectURL = () => {};
    class BrowserDate extends Date { static now() { return clock.now; } }
    class FileReader {
        readAsDataURL(file) {
            file.arrayBuffer().then(bytes => {
                this.result = `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`;
                this.onload();
            });
        }
    }
    const config = { signInReady: true, googleClientId: 'public-client-id', translationReady: true, maxPdfBytes: 2097152, maxPagesPerBatch: 5 };
    vm.runInNewContext(source, {
        window, document, URL: BrowserURL, Date: BrowserDate, Blob, FileReader,
        AbortController, AbortSignal, DOMException,
        MutationObserver: class { observe() {} },
        localStorage: { getItem() { throw new Error('Auth must not use localStorage'); }, setItem() { throw new Error('Auth must not use localStorage'); } },
        setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        async fetch(url, options) {
            const call = { path: new URL(url).pathname, options };
            calls.push(call);
            if (call.path === '/api/config') return reply(config);
            if (call.path === '/api/session') return session(call);
            if (call.path === '/api/translate') return reply({ pageCount: 1, endPage: 1, text: 'Translation', complete: true, finishReason: 'STOP' });
            throw new Error(`Unexpected request ${call.path}`);
        }
    });
    return { calls, timers, clock, google, byId, windowEvents, documentEvents, document };
}

test('restores the remembered owner before loading Google and caps a 30-day timer safely', async () => {
    const app = harness(() => reply(owner));
    assert.equal(app.byId('private-workspace').hidden, true);
    await flush();
    assert.equal(app.byId('private-workspace').hidden, false);
    assert.equal(app.google.loads, 0);
    assert.equal(app.calls.at(-1).options.credentials, 'include');
    assert.equal(app.calls.at(-1).options.headers.Authorization, undefined);
    assert.equal([...app.timers.values()][0].delay, 2147483647);
});

test('an anonymous restore is a normal sign-in state and Google bearer is used only for exchange', async () => {
    let signedIn = false;
    const app = harness(call => {
        if (call.options.headers.Authorization) signedIn = true;
        return signedIn ? reply(owner) : unsigned();
    });
    await flush();
    assert.equal(app.byId('private-workspace').hidden, true);
    assert.equal(app.byId('auth-note').textContent, 'Sign in with the site owner’s Google account.');
    assert.equal(app.byId('status-message').textContent, '');
    assert.equal(app.google.loads, 1);
    await app.google.callback({ credential: 'in-memory-google-token' });
    assert.equal(app.byId('private-workspace').hidden, false);
    const requests = app.calls.filter(call => call.path === '/api/session');
    assert.equal(requests.length, 3);
    assert.equal(requests[1].options.headers.Authorization, 'Bearer in-memory-google-token');
    assert.equal(requests[2].options.headers.Authorization, undefined);
    assert.ok(app.calls.every(call => call.options.credentials === 'include'));

    const file = new Blob(['%PDF-1.7\nfixture'], { type: 'application/pdf' });
    file.name = 'fixture.pdf';
    await app.byId('pdf-file').emit('change', { target: { files: [file] } });
    app.byId('privacy-consent').checked = true;
    await app.byId('translate-form').emit('submit');
    const translated = app.calls.find(call => call.path === '/api/translate');
    assert.ok(translated);
    assert.equal(translated.options.credentials, 'include');
    assert.equal(translated.options.headers.Authorization, undefined);
});

test('cookie rejection and a forbidden Google account never reveal PDF tools', async () => {
    for (const status of [200, 403]) {
        const app = harness(call => call.options.headers.Authorization ? reply(status === 200 ? owner : { error: { code: 'ACCOUNT_NOT_ALLOWED' } }, status) : unsigned());
        await flush();
        await app.google.callback({ credential: 'in-memory-google-token' });
        assert.equal(app.byId('private-workspace').hidden, true);
        assert.equal(app.byId('translator-fields').disabled, true);
        assert.match(app.byId('auth-note').textContent, status === 200 ? /sign in/i : /not allowed/);
    }
});

test('sign-out clears local documents first and offers a retry when cookie removal fails', async () => {
    let attempts = 0;
    const app = harness(call => {
        if (JSON.parse(call.options.body).action !== 'signout') return reply(owner);
        if (++attempts === 1) throw new Error('offline');
        return reply({ signedOut: true });
    });
    await flush();
    app.byId('pdf-preview').src = 'blob:old-preview';
    app.byId('sign-out').emit('click');
    assert.equal(app.byId('private-workspace').hidden, true);
    assert.equal(app.byId('pdf-preview').src, undefined);
    await flush();
    assert.equal(app.byId('account-info').hidden, false);
    assert.equal(app.byId('sign-out').disabled, false);
    assert.equal(app.google.loads, 0);
    assert.match(app.byId('auth-note').textContent, /select Sign out again/);
    app.byId('sign-out').emit('click');
    await flush();
    assert.equal(attempts, 2);
    assert.equal(app.byId('account-info').hidden, true);
    assert.equal(app.google.loads, 1);
    assert.ok(app.calls.every(call => !call.options.headers.Authorization));
});

test('returning from bfcache revalidates the cookie without signing out or restoring old documents', async () => {
    let valid = true;
    const app = harness(() => valid ? reply(owner) : unsigned());
    await flush();
    app.byId('pdf-preview').src = 'blob:old-preview';
    app.windowEvents.get('pagehide')();
    assert.equal(app.byId('private-workspace').hidden, true);
    assert.equal(app.byId('pdf-preview').src, undefined);
    valid = false;
    app.windowEvents.get('pageshow')({ persisted: true });
    await flush();
    assert.equal(app.byId('private-workspace').hidden, true);
    assert.equal(app.google.loads, 1);
    assert.ok(app.calls.filter(call => call.path === '/api/session').every(call => JSON.parse(call.options.body).action !== 'signout'));
});

test('a late session response after pagehide cannot reveal private tools', async () => {
    let resolve;
    const app = harness(() => new Promise(done => { resolve = done; }));
    await flush();
    app.windowEvents.get('pagehide')();
    resolve(reply(owner));
    await flush();
    assert.equal(app.byId('private-workspace').hidden, true);
    assert.equal(app.google.loads, 0);
});

test('leaving during sign-out preserves a retry instead of silently restoring the cookie', async () => {
    let resolve;
    const app = harness(call => JSON.parse(call.options.body).action === 'signout' ? new Promise(done => { resolve = done; }) : reply(owner));
    await flush();
    app.byId('sign-out').emit('click');
    app.windowEvents.get('pagehide')();
    resolve(reply({ signedOut: true }));
    await flush();
    app.windowEvents.get('pageshow')({ persisted: true });
    await flush();
    assert.equal(app.byId('private-workspace').hidden, true);
    assert.equal(app.byId('account-info').hidden, false);
    assert.equal(app.byId('sign-out').disabled, false);
    assert.match(app.byId('auth-note').textContent, /select Sign out again/);
    assert.equal(app.calls.filter(call => call.path === '/api/session').length, 2);
});

test('30-day sessions rearm the timer then clear access on expiry', async () => {
    const app = harness(() => reply(owner));
    await flush();
    const first = [...app.timers.values()][0];
    app.clock.now += first.delay;
    first.callback();
    assert.equal(app.byId('private-workspace').hidden, false);
    const next = [...app.timers.values()][0];
    assert.equal(next.delay, owner.exp * 1000 - app.clock.now);
    app.clock.now = owner.exp * 1000;
    next.callback();
    await flush();
    assert.equal(app.byId('private-workspace').hidden, true);
    assert.ok(app.calls.some(call => JSON.parse(call.options.body || '{}').action === 'signout'));
});
