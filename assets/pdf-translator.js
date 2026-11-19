(() => {
    'use strict';

    const languages = new Set(['zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es']);

    function normaliseApiBase(value) {
        const url = new URL(value);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
            throw new Error('INVALID_API_URL');
        }
        return url.origin;
    }

    function validateSelection(mode, start, end, size, maximum = 5) {
        const batchSize = Number(size);
        if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maximum) throw new Error('INVALID_RANGE');
        if (mode === 'all') return { start: 1, end: Infinity, batchSize };
        const first = Number(start);
        const last = Number(end);
        if (mode !== 'range' || !Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > 100) throw new Error('INVALID_RANGE');
        return { start: first, end: last, batchSize };
    }

    function isPdfHeader(bytes) {
        return bytes.length >= 5 && [37, 80, 68, 70, 45].every((byte, index) => bytes[index] === byte);
    }

    function makePreviewBlob(file) {
        return new Blob([file], { type: 'application/pdf' });
    }

    function downloadName(name, language, complete) {
        const stem = String(name).replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) || 'document';
        return `${stem}.${language}${complete ? '' : '.partial'}.md`;
    }

    function combineChunks(chunks, target) {
        return chunks.map(chunk => `${target === 'zh-CN' ? '## 第 ' : '## Pages '}${chunk.startPage}–${chunk.endPage}${target === 'zh-CN' ? ' 页' : ''}\n\n${chunk.text}`).join('\n\n---\n\n');
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { normaliseApiBase, validateSelection, isPdfHeader, makePreviewBlob, downloadName, combineChunks };
    }
    if (typeof document === 'undefined') return;

    const messages = {
        checking: ['Checking availability…', '正在检查服务状态…'],
        unavailable: ['The owner workspace is being configured. Please try again later.', '所有者工作区正在配置中，请稍后再试。'],
        ready: ['Ready for Google sign-in', '可以使用 Google 登录'],
        signedIn: ['Account verified', '账户已验证'],
        authNeeded: ['Sign in with the site owner’s Google account.', '请使用网站所有者的 Google 账户登录。'],
        authChecking: ['Verifying your Google account…', '正在验证 Google 账户…'],
        restoring: ['Checking your saved sign-in…', '正在检查已保存的登录状态…'],
        signingOut: ['Signing out…', '正在退出登录…'],
        signOutFailed: ['Local documents have been cleared, but your saved sign-in could not be removed. Check your connection and select Sign out again.', '本地文档已清除，但未能清除已保存的登录状态。请检查网络后再次点击退出登录。'],
        AUTH_FORBIDDEN: ['This Google account is not allowed to use this workspace.', '此 Google 账户没有使用此工作区的权限。'],
        AUTH_REQUIRED: ['Please sign in with Google first.', '请先使用 Google 登录。'],
        AUTH_INVALID: ['Your sign-in has expired or could not be verified. Please sign in again.', '登录已过期或无法验证，请重新登录。'],
        SERVICE_NOT_CONFIGURED: ['The workspace is not available yet.', '工作区暂未开放。'],
        signedOut: ['Signed out. Local documents and translations have been cleared.', '已退出登录，当前页面中的文档和译文已清除。'],
        expired: ['Your sign-in expired. Sign in again to use the workspace.', '登录已过期，请重新登录后使用工作区。'],
        fileHint: ['PDF only, up to {max} MiB.', '仅限 PDF，最大 {max} MiB。'],
        fileSelected: ['{name} · {size} MiB · stays on your device until you translate', '{name} · {size} MiB · 开始翻译前仅在本机读取'],
        PDF_TOO_LARGE: ['Choose a PDF no larger than {max} MiB.', '请选择不超过 {max} MiB 的 PDF。'],
        INVALID_PDF: ['This file could not be read as a PDF. Use an unencrypted PDF.', '无法读取此 PDF，请使用未加密的有效 PDF。'],
        PDF_ENCRYPTED: ['Unlock the PDF before uploading it.', '请先解除 PDF 的密码保护。'],
        PDF_TOO_MANY_PAGES: ['This workspace supports documents of up to 100 pages.', '此工作区支持最多 100 页的文档。'],
        PDF_REQUIRED: ['Select one PDF to continue.', '请先选择一个 PDF。'],
        INVALID_RANGE: ['Enter a valid page range and select 1–5 pages per step.', '请输入有效页码范围，每次选择 1–5 页。'],
        INVALID_LANGUAGE: ['Choose a supported target language.', '请选择支持的目标语言。'],
        consent: ['Confirm that this PDF may be sent to Google Gemini.', '请确认同意将此 PDF 发送给 Google Gemini。'],
        reading: ['Reading the PDF on your device…', '正在本机读取 PDF…'],
        uploading: ['Uploading the PDF to Gemini…', '正在上传 PDF 到 Gemini…'],
        UPLOAD_UNAVAILABLE: ['The PDF upload could not be completed. Try again.', 'PDF 上传未完成，请重试。'],
        UPLOAD_NOT_READY: ['Gemini could not confirm the upload. Try again.', 'Gemini 未能确认上传，请重试。'],
        INVALID_UPLOAD: ['The upload expired or could not be verified. Start the translation again.', '上传已过期或无法验证，请重新开始翻译。'],
        translating: ['Translating pages {start}–{end}…', '正在翻译第 {start}–{end} 页…'],
        progress: ['Completed pages {start}–{end} of the selected {total} pages', '已完成第 {start}–{end} 页，选定范围共 {total} 页'],
        complete: ['Translation complete. Review the text against the original before using it.', '翻译完成。使用前请对照原文检查。'],
        partial: ['The response is incomplete. The available text is kept below. Retry with fewer pages per step.', '返回内容不完整，已有译文保留在下方。请减少每次页数后重试。'],
        cancelled: ['Translation stopped. Finished sections are kept below.', '翻译已停止，已完成的部分保留在下方。'],
        resultSummary: ['{name} · pages {start}–{end} · {state}', '{name} · 第 {start}–{end} 页 · {state}'],
        completeLabel: ['Complete', '完整译文'],
        partialLabel: ['Partial translation', '部分译文'],
        copied: ['Translation copied.', '译文已复制。'],
        copyFailed: ['Copy was unavailable. Download the Markdown file instead.', '无法使用剪贴板，请下载 Markdown 文件。'],
        printHelp: ['Choose “Save as PDF” in the print dialog to keep a PDF copy.', '可在打印窗口中选择“另存为 PDF”保存译文。'],
        NETWORK_ERROR: ['The service could not be reached. Check your connection and try again.', '无法连接服务，请检查网络后重试。'],
        GEMINI_RATE_LIMITED: ['Gemini is rate limited. Wait a little before trying again.', 'Gemini 请求达到限额，请稍后重试。'],
        GEMINI_TIMEOUT: ['The translation timed out. Try a smaller page range.', '翻译超时，请缩小页码范围后重试。'],
        GEMINI_BLOCKED: ['Gemini could not process this document.', 'Gemini 无法处理这份文档。'],
        GEMINI_ERROR: ['Gemini could not finish this translation. Try again later.', 'Gemini 未能完成翻译，请稍后再试。'],
        REQUEST_TOO_LARGE: ['The upload is too large. Choose a smaller PDF.', '上传内容过大，请选择较小的 PDF。'],
        SERVER_ERROR: ['The request could not be completed. Your finished sections are kept below.', '请求未能完成，已完成的部分会保留在下方。']
    };

    function initialise() {
        const byId = id => document.getElementById(id);
        if (!byId('translate-form')) return;
        const ui = Object.fromEntries(['private-workspace', 'google-signin', 'auth-note', 'account-info', 'account-name', 'sign-out', 'service-status', 'translate-form', 'translator-fields', 'drop-zone', 'pdf-file', 'selected-file', 'target-language', 'page-mode', 'range-controls', 'page-start', 'page-end', 'batch-size', 'privacy-consent', 'submit-translation', 'cancel-translation', 'translation-progress', 'progress-bar', 'progress-label', 'status-message', 'result-section', 'result-summary', 'translation-output', 'copy-result', 'download-result', 'print-result', 'source-preview', 'pdf-preview', 'open-original'].map(id => [id, byId(id)]));
        const state = { config: null, base: '', account: null, file: null, fileUrl: null, fileVersion: 0, running: false, controller: null, chunks: [], complete: false, resultTarget: 'zh-CN', timer: null, status: null, service: 'checking', auth: 'restoring', job: null, signingIn: false, restoring: true, signingOut: false, logoutFailed: false, authVersion: 0, authController: null, googlePromise: null, googleInitialised: false };
        const language = () => document.documentElement.lang.startsWith('zh') ? 1 : 0;
        const inlineLimit = () => state.config?.maxPdfBytes || 2 * 1048576;
        const uploadLimit = () => state.config?.maxUploadBytes || inlineLimit();
        const t = (key, params = {}) => (messages[key] || messages.SERVER_ERROR)[language()].replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? (name === 'max' ? uploadLimit() / 1048576 : '')));
        const status = (key, params = {}, tone = '') => {
            state.status = { key, params, tone };
            ui['status-message'].textContent = t(key, params);
            ui['status-message'].dataset.state = tone;
        };

        function controls() {
            const authorised = Boolean(state.account && state.account.exp * 1000 > Date.now());
            ui['private-workspace'].hidden = !authorised;
            ui['account-info'].hidden = !authorised && !state.logoutFailed;
            ui['google-signin'].hidden = authorised || state.restoring || state.signingOut || state.logoutFailed;
            ui['sign-out'].disabled = state.signingOut;
            ui['translator-fields'].disabled = !authorised || !state.config?.translationReady;
            for (const id of ['pdf-file', 'target-language', 'page-mode', 'page-start', 'page-end', 'batch-size', 'privacy-consent']) ui[id].disabled = state.running;
            for (const id of ['page-start', 'page-end']) ui[id].disabled = state.running || ui['page-mode'].value !== 'range';
            ui['submit-translation'].disabled = state.running || !state.file;
            ui['cancel-translation'].hidden = !state.running;
            ui['range-controls'].hidden = ui['page-mode'].value !== 'range';
            for (const id of ['copy-result', 'download-result', 'print-result']) ui[id].disabled = !state.chunks.length;
            ui['account-name'].textContent = state.account ? `${state.account.name || ''}${state.account.name ? ' · ' : ''}${state.account.email}` : '';
            ui['auth-note'].textContent = t(state.auth);
            ui['service-status'].textContent = t(state.service);
        }

        function showFile() {
            ui['selected-file'].textContent = state.file ? t('fileSelected', { name: state.file.name, size: (state.file.size / 1048576).toFixed(2) }) : t('fileHint');
        }

        function refreshLocale() {
            controls();
            showFile();
            if (state.status) status(state.status.key, state.status.params, state.status.tone);
            if (state.job?.total) renderProgress();
            if (state.chunks.length) renderSummary();
        }

        function clearDocument() {
            clearUploadedPdf(state.job);
            state.fileVersion++;
            if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
            state.file = null;
            state.fileUrl = null;
            state.chunks = [];
            state.complete = false;
            state.job = null;
            ui['pdf-file'].value = '';
            ui['privacy-consent'].checked = false;
            ui['pdf-preview'].removeAttribute('src');
            ui['open-original'].removeAttribute('href');
            ui['source-preview'].hidden = true;
            ui['result-section'].hidden = true;
            ui['translation-progress'].hidden = true;
            ui['translation-output'].replaceChildren();
            ui['result-summary'].textContent = '';
        }

        function clearSession() {
            state.authVersion++;
            state.authController?.abort();
            state.authController = null;
            state.controller?.abort();
            state.account = null;
            state.signingIn = false;
            state.restoring = false;
            clearTimeout(state.timer);
            state.timer = null;
            clearDocument();
        }

        async function signOut(expired = false) {
            if (state.signingOut) return;
            clearSession();
            const version = state.authVersion;
            state.signingOut = true;
            state.logoutFailed = false;
            state.auth = 'signingOut';
            const controller = new AbortController();
            state.authController = controller;
            window.google?.accounts?.id?.disableAutoSelect();
            controls();
            showFile();
            try {
                if (state.base) await api('session', { method: 'POST', body: JSON.stringify({ action: 'signout' }), signal: controller.signal });
                if (version !== state.authVersion) return;
                state.auth = expired ? 'expired' : 'signedOut';
                status(expired ? 'expired' : 'signedOut');
            } catch {
                if (version !== state.authVersion) return;
                state.logoutFailed = true;
                state.auth = 'signOutFailed';
                status('signOutFailed', {}, 'error');
            } finally {
                state.signingOut = false;
                if (state.authController === controller) state.authController = null;
                state.service = state.config?.signInReady ? 'ready' : 'unavailable';
                controls();
            }
            if (!state.logoutFailed && version === state.authVersion) await offerGoogleSignIn();
        }

        function scheduleExpiry() {
            clearTimeout(state.timer);
            if (!state.account) return;
            const remaining = state.account.exp * 1000 - Date.now();
            if (remaining <= 0) { void signOut(true); return; }
            // Browser timers overflow after about 24.8 days; remembered sessions last 30 days.
            state.timer = setTimeout(scheduleExpiry, Math.min(remaining, 2147483647));
        }

        function acceptSession(account) {
            if (!account || typeof account.email !== 'string' || !account.email || !Number.isFinite(account.exp) || account.exp * 1000 <= Date.now()) throw new Error('AUTH_INVALID');
            state.account = account;
            state.logoutFailed = false;
            state.auth = 'signedIn';
            state.service = state.config.translationReady ? 'signedIn' : 'unavailable';
            scheduleExpiry();
            state.status = null;
            ui['status-message'].textContent = '';
        }

        async function restoreSession() {
            clearSession();
            const version = state.authVersion;
            const controller = new AbortController();
            state.authController = controller;
            state.restoring = true;
            state.auth = 'restoring';
            controls();
            try {
                const account = await api('session', { method: 'POST', body: '{}', signal: controller.signal });
                if (version !== state.authVersion) return;
                acceptSession(account);
            } catch (error) {
                if (version !== state.authVersion) return;
                state.auth = error.httpStatus === 401 ? 'authNeeded' : messages[error.message] ? error.message : 'NETWORK_ERROR';
                state.service = state.config.signInReady ? 'ready' : 'unavailable';
            } finally {
                if (version === state.authVersion) {
                    state.restoring = false;
                    state.authController = null;
                    controls();
                }
            }
            if (version === state.authVersion && !state.account) await offerGoogleSignIn();
        }

        async function offerGoogleSignIn() {
            if (state.account || state.restoring || state.signingOut || state.logoutFailed || !state.config?.signInReady) return;
            try { await loadGoogle(); }
            catch { state.service = 'unavailable'; }
            controls();
        }

        async function api(path, options = {}) {
            const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
            const requestSignal = path === 'session' && options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : options.signal || AbortSignal.timeout(20000);
            let response;
            try {
                response = await fetch(`${state.base}/api/${path}`, { ...options, headers, credentials: 'include', cache: 'no-store', signal: requestSignal });
            } catch (error) {
                if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
                throw new Error('NETWORK_ERROR');
            }
            let body;
            try { body = await response.json(); } catch (error) { if (error.name === 'AbortError') throw error; throw new Error('SERVER_ERROR'); }
            options.signal?.throwIfAborted();
            if (!response.ok) {
                const aliases = { ACCOUNT_NOT_ALLOWED: 'AUTH_FORBIDDEN', INVALID_ID_TOKEN: 'AUTH_INVALID', SIGN_IN_NOT_CONFIGURED: 'SERVICE_NOT_CONFIGURED', TRANSLATION_NOT_CONFIGURED: 'SERVICE_NOT_CONFIGURED', INVALID_PAGE_RANGE: 'INVALID_RANGE', INVALID_PDF_ENCODING: 'INVALID_PDF', ENCRYPTED_PDF: 'PDF_ENCRYPTED', TOO_MANY_PAGES: 'PDF_TOO_MANY_PAGES', BODY_TOO_LARGE: 'REQUEST_TOO_LARGE', GEMINI_UNAVAILABLE: 'GEMINI_ERROR', GEMINI_EMPTY_RESPONSE: 'GEMINI_ERROR', GEMINI_INCOMPLETE_RESPONSE: 'partial' };
                const code = aliases[body.error?.code] || body.error?.code || (response.status === 401 ? 'AUTH_INVALID' : response.status === 403 ? 'AUTH_FORBIDDEN' : 'SERVER_ERROR');
                const error = new Error(code);
                error.httpStatus = response.status;
                throw error;
            }
            return body;
        }

        async function credentialReceived(response) {
            if (state.signingIn || state.restoring || state.signingOut || state.logoutFailed || state.account || !response?.credential) return;
            const version = ++state.authVersion;
            const controller = new AbortController();
            state.authController = controller;
            state.signingIn = true;
            state.auth = 'authChecking';
            controls();
            try {
                await api('session', { method: 'POST', body: '{}', headers: { Authorization: `Bearer ${response.credential}` }, signal: controller.signal });
                if (version !== state.authVersion) return;
                // Confirm the browser accepted the HttpOnly cookie before showing private tools.
                const account = await api('session', { method: 'POST', body: '{}', signal: controller.signal });
                if (version !== state.authVersion) return;
                acceptSession(account);
            } catch (error) {
                if (version !== state.authVersion) return;
                state.account = null;
                state.auth = messages[error.message] ? error.message : 'AUTH_INVALID';
                status(state.auth, {}, 'error');
            } finally {
                if (version === state.authVersion) {
                    state.signingIn = false;
                    state.authController = null;
                    controls();
                }
            }
        }

        async function loadGoogle() {
            if (!window.google?.accounts?.id) {
                if (!state.googlePromise) {
                    state.googlePromise = new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        script.src = 'https://accounts.google.com/gsi/client';
                        script.async = true;
                        script.onload = resolve;
                        script.onerror = () => { script.remove(); state.googlePromise = null; reject(new Error('NETWORK_ERROR')); };
                        document.head.append(script);
                    });
                }
                await state.googlePromise;
            }
            if (state.account || state.restoring || state.signingOut || state.logoutFailed) return;
            if (!state.googleInitialised) {
                window.google.accounts.id.initialize({ client_id: state.config.googleClientId, callback: credentialReceived, auto_select: false });
                state.googleInitialised = true;
            }
            renderGoogleButton();
        }

        function renderGoogleButton() {
            if (state.account || state.restoring || state.signingIn || state.signingOut || state.logoutFailed || !state.googleInitialised || !window.google?.accounts?.id) return;
            const width = Math.min(260, Math.floor(ui['google-signin'].getBoundingClientRect().width) || 260);
            ui['google-signin'].replaceChildren();
            window.google.accounts.id.renderButton(ui['google-signin'], { theme: 'outline', size: 'large', type: 'standard', shape: 'rectangular', text: 'signin_with', width });
        }

        async function chooseFile(file) {
            if (!state.account || state.running) return;
            clearDocument();
            const fileVersion = state.fileVersion;
            if (!file) { controls(); showFile(); return; }
            try {
                if (!file.size) throw new Error('INVALID_PDF');
                if (file.size > uploadLimit()) throw new Error('PDF_TOO_LARGE');
                if (!isPdfHeader(new Uint8Array(await file.slice(0, 1024).arrayBuffer()))) throw new Error('INVALID_PDF');
                if (fileVersion !== state.fileVersion || !state.account) return;
                state.file = file;
                state.fileUrl = URL.createObjectURL(makePreviewBlob(file));
                ui['pdf-preview'].src = state.fileUrl;
                ui['open-original'].href = state.fileUrl;
                ui['source-preview'].hidden = false;
                state.status = null;
                ui['status-message'].textContent = '';
            } catch (error) { if (fileVersion === state.fileVersion && state.account) status(error.message, {}, 'error'); }
            controls();
            showFile();
        }

        function fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                reader.onerror = () => reject(new Error('INVALID_PDF'));
                reader.readAsDataURL(file);
            });
        }

        async function uploadLargePdf(file, selection, job, signal) {
            const { PDFDocument, EncryptedPDFError } = await import('./vendor/pdf-lib-1.17.1.esm.min.js')
                .catch(() => { throw new Error('UPLOAD_UNAVAILABLE'); });
            let pageCount;
            try {
                const document = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: false, throwOnInvalidObject: true });
                pageCount = document.getPageCount();
            } catch (error) {
                throw new Error(error instanceof EncryptedPDFError || error?.message === new EncryptedPDFError().message ? 'PDF_ENCRYPTED' : 'INVALID_PDF');
            }
            signal.throwIfAborted();
            if (!pageCount) throw new Error('INVALID_PDF');
            if (pageCount > state.config.maxDocumentPages) throw new Error('PDF_TOO_MANY_PAGES');
            if (selection.start > pageCount) throw new Error('INVALID_RANGE');
            status('uploading');
            const grant = await api('upload', {
                method: 'POST', signal, body: JSON.stringify({ action: 'start', sizeBytes: file.size, pageCount })
            });
            if (typeof grant.fileToken !== 'string' || typeof grant.uploadUrl !== 'string') throw new Error('UPLOAD_UNAVAILABLE');
            job.fileToken = grant.fileToken;
            const uploadUrl = new URL(grant.uploadUrl);
            if (uploadUrl.origin !== 'https://generativelanguage.googleapis.com' || uploadUrl.pathname !== '/upload/v1beta/files' ||
                uploadUrl.username || uploadUrl.password || uploadUrl.hash) throw new Error('UPLOAD_UNAVAILABLE');
            let result;
            try {
                result = await fetch(uploadUrl, {
                    method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
                    headers: { 'Content-Type': 'application/pdf', 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0' },
                    body: file, signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)])
                });
            } catch (error) {
                signal.throwIfAborted();
                // Google may finish the upload without making its response accessible through CORS.
                if (error.name !== 'TypeError') throw new Error('UPLOAD_UNAVAILABLE');
            }
            if (result && !result.ok) throw new Error('UPLOAD_UNAVAILABLE');
            const body = JSON.stringify({ action: 'status', fileToken: job.fileToken });
            for (let attempt = 0; attempt < 12; attempt++) {
                signal.throwIfAborted();
                if ((await api('upload', { method: 'POST', signal, body })).ready === true) {
                    return { fileToken: job.fileToken };
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            throw new Error('UPLOAD_NOT_READY');
        }

        function clearUploadedPdf(job) {
            if (!job?.fileToken) return;
            const body = JSON.stringify({ action: 'delete', fileToken: job.fileToken });
            job.fileToken = null;
            void api('upload', { method: 'POST', keepalive: true, body }).catch(() => {});
        }

        function appendInline(parent, text) {
            const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
            let previous = 0;
            for (const match of text.matchAll(pattern)) {
                parent.append(document.createTextNode(text.slice(previous, match.index)));
                const strong = match[0].startsWith('**');
                const element = document.createElement(strong ? 'strong' : 'code');
                element.textContent = match[0].slice(strong ? 2 : 1, strong ? -2 : -1);
                parent.append(element);
                previous = match.index + match[0].length;
            }
            parent.append(document.createTextNode(text.slice(previous)));
        }

        function renderMarkdown(markdown) {
            const fragment = document.createDocumentFragment();
            const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
            let paragraph = [];
            let list = null;
            const flush = () => {
                if (paragraph.length) { const p = document.createElement('p'); appendInline(p, paragraph.join('\n')); fragment.append(p); paragraph = []; }
                list = null;
            };
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim()) { flush(); continue; }
                if (line.startsWith('```')) {
                    flush();
                    const codeLines = [];
                    while (++i < lines.length && !lines[i].startsWith('```')) codeLines.push(lines[i]);
                    const pre = document.createElement('pre'); pre.textContent = codeLines.join('\n'); fragment.append(pre); continue;
                }
                const heading = /^(#{1,6})\s+(.+)$/.exec(line);
                if (heading) { flush(); const h = document.createElement(`h${Math.min(heading[1].length + 1, 6)}`); appendInline(h, heading[2]); fragment.append(h); continue; }
                if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flush(); fragment.append(document.createElement('hr')); continue; }
                const bullet = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line);
                if (bullet) {
                    if (paragraph.length) flush();
                    const tag = bullet[1] ? 'ul' : 'ol';
                    if (!list || list.localName !== tag) { list = document.createElement(tag); fragment.append(list); }
                    const item = document.createElement('li'); appendInline(item, bullet[2]); list.append(item); continue;
                }
                if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
                    flush();
                    const wrapper = document.createElement('div'); wrapper.className = 'translation-table';
                    const table = document.createElement('table');
                    const row = (value, header) => {
                        const tr = document.createElement('tr');
                        const cells = value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
                        for (const cell of cells) { const td = document.createElement(header ? 'th' : 'td'); if (header) td.scope = 'col'; appendInline(td, cell.trim()); tr.append(td); }
                        table.append(tr);
                    };
                    row(line, true); i++;
                    while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) row(lines[++i], false);
                    wrapper.append(table); fragment.append(wrapper); continue;
                }
                if (list) flush();
                paragraph.push(line);
            }
            flush();
            ui['translation-output'].replaceChildren(fragment);
        }

        function renderSummary() {
            if (!state.chunks.length || !state.file) return;
            ui['result-summary'].textContent = t('resultSummary', { name: state.file.name, start: state.chunks[0].startPage, end: state.chunks.at(-1).endPage, state: t(state.complete ? 'completeLabel' : 'partialLabel') });
        }

        function renderProgress() {
            const job = state.job;
            if (!job?.total) return;
            const done = Math.max(0, job.lastCompleted - job.start + 1);
            ui['progress-bar'].value = Math.min(100, Math.round(done / job.total * 100));
            ui['progress-label'].textContent = t('progress', { start: job.start, end: Math.max(job.start - 1, job.lastCompleted), total: job.total });
        }

        async function translate(event) {
            event.preventDefault();
            if (state.running) return;
            const version = state.authVersion;
            let job;
            try {
                if (!state.account) throw new Error('AUTH_REQUIRED');
                if (state.account.exp * 1000 <= Date.now() + 5000) { signOut(true); return; }
                if (!state.config?.translationReady) throw new Error('SERVICE_NOT_CONFIGURED');
                if (!state.file) throw new Error('PDF_REQUIRED');
                if (!ui['privacy-consent'].checked) throw new Error('consent');
                const target = ui['target-language'].value;
                if (!languages.has(target)) throw new Error('INVALID_LANGUAGE');
                const selection = validateSelection(ui['page-mode'].value, ui['page-start'].value, ui['page-end'].value, ui['batch-size'].value, state.config.maxPagesPerBatch || 5);
                state.running = true;
                state.complete = false;
                state.chunks = [];
                state.resultTarget = target;
                state.controller = new AbortController();
                const signal = state.controller.signal;
                job = { start: selection.start, total: null, lastCompleted: selection.start - 1 };
                state.job = job;
                ui['translation-output'].replaceChildren();
                ui['result-summary'].textContent = '';
                ui['result-section'].hidden = false;
                ui['translation-progress'].hidden = false;
                ui['progress-bar'].value = 0;
                ui['progress-label'].textContent = '';
                controls();
                status('reading');
                const documentInput = state.file.size > inlineLimit()
                    ? await uploadLargePdf(state.file, selection, job, signal)
                    : { pdfBase64: await fileToBase64(state.file) };
                let next = selection.start;
                let finalPage = selection.end;
                while (next <= finalPage) {
                    signal.throwIfAborted();
                    const endPage = Math.min(next + selection.batchSize - 1, finalPage);
                    status('translating', { start: next, end: endPage });
                    const result = await api('translate', { method: 'POST', signal, body: JSON.stringify({ ...documentInput, targetLanguage: target, startPage: next, endPage }) });
                    if (version !== state.authVersion) return;
                    if (!Number.isInteger(result.pageCount) || !Number.isInteger(result.endPage) || result.endPage < next || result.endPage > endPage || typeof result.text !== 'string' || !result.text.trim()) throw new Error('SERVER_ERROR');
                    finalPage = Math.min(selection.end, result.pageCount);
                    state.job.total = finalPage - selection.start + 1;
                    state.chunks.push({ startPage: next, endPage: result.endPage, text: result.text, complete: result.complete === true && result.finishReason === 'STOP' });
                    renderMarkdown(combineChunks(state.chunks, target));
                    if (!state.chunks.at(-1).complete) { status('partial', {}, 'warning'); break; }
                    state.job.lastCompleted = result.endPage;
                    renderProgress();
                    next = result.endPage + 1;
                    if (next > finalPage) { state.complete = true; status('complete', {}, 'success'); }
                    renderSummary();
                }
            } catch (error) {
                if (version !== state.authVersion || !state.account) return;
                if (error.httpStatus === 401 || error.httpStatus === 403) { signOut(); status(error.message, {}, 'error'); return; }
                if (error.name === 'AbortError') status('cancelled', {}, 'warning');
                else status(error.name === 'TimeoutError' ? 'GEMINI_TIMEOUT' : error.message, {}, 'error');
            } finally {
                clearUploadedPdf(job);
                if (version === state.authVersion) {
                    state.running = false;
                    state.controller = null;
                    renderSummary();
                    controls();
                }
            }
        }

        ui['translate-form'].addEventListener('submit', translate);
        ui['pdf-file'].addEventListener('change', event => chooseFile(event.target.files[0]));
        ui['page-mode'].addEventListener('change', controls);
        ui['cancel-translation'].addEventListener('click', () => state.controller?.abort());
        ui['sign-out'].addEventListener('click', () => signOut());
        ui['drop-zone'].addEventListener('keydown', event => { if (event.target === ui['drop-zone'] && ['Enter', ' '].includes(event.key) && !ui['translator-fields'].disabled && !state.running) { event.preventDefault(); ui['pdf-file'].click(); } });
        for (const type of ['dragover', 'dragleave', 'drop']) ui['drop-zone'].addEventListener(type, event => {
            event.preventDefault();
            ui['drop-zone'].classList.toggle('is-dragging', type === 'dragover' && Boolean(state.account) && !state.running);
            if (type === 'drop' && state.account && !state.running) {
                if (event.dataTransfer.files.length !== 1) status('PDF_REQUIRED', {}, 'error');
                else chooseFile(event.dataTransfer.files[0]);
            }
        });
        ui['copy-result'].addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(combineChunks(state.chunks, state.resultTarget)); status('copied', {}, 'success'); }
            catch { status('copyFailed', {}, 'warning'); }
        });
        ui['download-result'].addEventListener('click', () => {
            const blob = new Blob([combineChunks(state.chunks, state.resultTarget)], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = downloadName(state.file.name, state.resultTarget, state.complete); anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        ui['print-result'].addEventListener('click', () => { status('printHelp'); window.print(); });
        window.addEventListener('pagehide', () => {
            if (state.signingOut) { state.logoutFailed = true; state.auth = 'signOutFailed'; }
            clearSession();
            controls();
            showFile();
        });
        window.addEventListener('pageshow', event => {
            if (!event.persisted) return;
            if (state.logoutFailed || state.signingOut) { controls(); return; }
            if (state.config) void restoreSession();
            else void initialiseAvailability();
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && state.account?.exp * 1000 <= Date.now()) void signOut(true);
        });
        let resizeTimer;
        window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderGoogleButton, 150); });
        new MutationObserver(refreshLocale).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

        controls();
        showFile();
        async function initialiseAvailability() {
            const version = state.authVersion;
            try {
                const base = window.PDF_TRANSLATOR_CONFIG?.apiBaseUrl;
                if (!base) throw new Error('SERVICE_NOT_CONFIGURED');
                state.base = normaliseApiBase(base);
                state.config = await api('config');
                if (version !== state.authVersion) return;
                showFile();
                if (!state.config.signInReady || !state.config.googleClientId) throw new Error('SERVICE_NOT_CONFIGURED');
                await restoreSession();
            } catch {
                if (version !== state.authVersion) return;
                state.restoring = false;
                state.auth = 'SERVICE_NOT_CONFIGURED';
                state.service = 'unavailable';
            }
            controls();
        }
        void initialiseAvailability();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialise, { once: true });
    else initialise();
})();
