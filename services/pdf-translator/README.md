# 私人 PDF 翻译 API

这是独立部署到 Vercel 的 Node.js 后端。学术网站及翻译页面继续由 GitHub Pages 托管；后端项目根目录必须设为 `services/pdf-translator`，不会构建或替换个人网站。

后端只允许已配置的一个 Google 邮箱。首次登录使用 `google-auth-library` 验证 Google ID token 的签名、签发者、受众和有效期，再检查 `email_verified === true` 与规范化邮箱完全一致。可选的 Google `sub` 进一步锁定同一账号。验证成功后签发最长 30 天的网站会话；每次恢复、上传管理和翻译都在后端验证会话有效期及当前身份配置。Google ID token 不持久保存。缺少身份配置或 Gemini key 时拒绝翻译。

## 配置

在 Vercel 项目的 Environment Variables 中设置以下变量。真实值不要提交到 Git，也不要填到 GitHub Pages 的前端代码中。

| 变量 | 用途 |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google Cloud 中 **Web application** OAuth 2.0 Client ID。Client ID 本身是公开值，会由 `/api/config` 返回。无需 Client Secret。 |
| `ALLOWED_GOOGLE_EMAIL` | 唯一允许登录的完整 Google 邮箱；比较前会 trim 并转为小写。必须配置。 |
| `ALLOWED_GOOGLE_SUB` | 可选；该 Google 账号 ID token 中的稳定 `sub`。配置后邮箱和 `sub` 均须匹配。 |
| `OWNER_SESSION_SECRET` | 必须配置的服务端随机秘密，至少 32 字节、最多 1024 字节。用于加密认证 30 天会话并签名大文件上传凭证；不能与 API key 共用或放入前端。 |
| `GEMINI_FREE_TIER_API_KEY` | 在 Google AI Studio 确认所属项目为 **Free Tier**、未关联有效 Cloud Billing 账户后，才设置此密钥。只用于服务端请求头。 |
| `GEMINI_MODEL` | 可选。默认 `gemini-3.5-flash-lite`，也可使用 `gemini-3.1-flash-lite`。仅允许这两个支持 PDF 的免费层模型 ID。 |
| `ALLOWED_ORIGINS` | 可选；逗号分隔的完整 origin，不含尾部 `/` 或路径。默认 `https://furonglin.github.io,http://localhost:8000,http://127.0.0.1:8000`。显式配置会替换默认列表。不能用 `*`。 |
| `NODEJS_HELPERS` | 必须为 `0`，禁用 Vercel 的请求体 helper，使处理函数直接限制原始请求字节。本项目 `vercel.json` 已设定该非敏感值。 |

Google Cloud OAuth 客户端的 **Authorized JavaScript origins** 应包含 `https://furonglin.github.io`；本地测试时再加入 `http://localhost:8000`、`http://127.0.0.1:8000`。Google 登录运行在前端 origin；通常不需要将纯 API 的 Vercel origin 加入该列表。本流程使用 Google Identity Services 的 ID token，不使用 OAuth redirect，也不请求 Google Drive 权限。

如果 OAuth consent screen 处于 Testing，将自己的账号添加到 Test users。`ALLOWED_GOOGLE_EMAIL` 仍由后端独立校验；Google 测试用户设置和 CORS 都不能替代鉴权。

免费额度由密钥所属的 Google 项目决定。即使模型支持免费层，启用计费的项目也可能按用量收费。模型请求无法指定免费档，后端也无法仅凭 Gemini 密钥验证项目计费状态。部署前在 [AI Studio 项目列表](https://aistudio.google.com/projects) 核对计划，使用独立的未启用计费项目。免费额度或速率用尽时，服务显示限制错误，不会切换模型、密钥或计费方案。向英国、欧洲经济区或瑞士的用户提供 API 客户端时，Google 要求使用付费服务，请先核对 [Gemini API 条款](https://aistudio.google.com/docs/terms#use-restrictions) 的适用范围。

## 部署

1. 使用已从 `furonglin.github.io` 仓库导入的 Vercel 项目。Root Directory 设为 `services/pdf-translator`，Framework Preset 选 **Other**，Node.js 版本为 **24.x**，启用 Fluid compute。
2. 添加上述变量，在需要使用的 Production / Preview 环境都正确设置。`package.json` 固定 Node 24 及依赖版本；`vercel.json` 使用 `npm ci --omit=dev`，禁用网站构建，静态输出只来自 `public/` 中的通用服务说明页。
3. 部署后检查 `GET https://<项目域名>/api/config`。身份配置齐全后 `signInReady` 为 `true`，设置免费层密钥且模型在允许名单中后 `translationReady` 为 `true`；配置会话秘密后 `maxUploadBytes` 应为 `10485760`。这些值只表示应用配置就绪，实际登录、Cookie、翻译和 Google 项目计费状态需分别验证。
4. 将前端的后端基础 URL 配置为此项目的 HTTPS origin。用支持分区 Cookie 的当前 Chromium 浏览器验证真实 Google 登录、刷新后的会话恢复、退出，以及小 PDF 和 2–10 MiB PDF 的翻译与清理。

本项目是 API 服务，根路径 `/` 只显示通用服务说明，不显示翻译功能。函数最大执行时间 300 秒，单次 Gemini 请求上限 240 秒。配置变化需要重新部署；本地改动不代表已上线。

`OWNER_SESSION_SECRET` 可在本地终端生成后填入 Vercel 的秘密环境变量，不要将输出提交到仓库或日志：

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
vercel env add OWNER_SESSION_SECRET production
```

需要 Preview 时为该环境另行设置。轮换秘密或修改 Google Client ID、允许邮箱、`sub` 后，既有会话会失效；轮换秘密也会使未完成的上传凭证失效。先部署后端配置与接口，再更新前端；旧的 2 MiB inline 请求仍兼容。

网站会话 Cookie 为 `__Host-owner_session`，具有 `Path=/; HttpOnly; Secure; SameSite=None; Partitioned`，最长 30 天，恢复会话不延长原到期时间。生产环境需 HTTPS，前端请求使用 `credentials: 'include'`；后端响应允许指定 origin 携带凭据。Cookie 按顶层网站分区，在另一个顶层网站或直接访问 API 时不会共享登录。浏览器若拒绝此 Cookie，前端会要求重新登录，不以 localStorage token 代替。普通 HTTP 本地预览不代表跨站安全 Cookie 已通过验收；完整登录验收应使用已授权的 HTTPS 前端 origin。

## API

所有 JSON 错误统一为 `{ "error": { "code": "稳定错误代码", "message": "安全说明" } }`。所有响应使用 `Cache-Control: no-store`，不返回 Google/Gemini 原始错误。

### `GET /api/config`

公开仅返回登录必需的 `googleClientId`、文件和页数限制，以及 `signInReady`、`translationReady` 状态。`maxPdfBytes` 是 inline 上限 2 MiB，`maxUploadBytes` 是当前可用上传上限，完整配置时为 10 MiB。不会返回允许邮箱、Google `sub`、密钥或服务端模型配置；登录客户端 ID 本身是公开应用编号。

GitHub Pages 的 `_config.yml` 应排除 `services/` 和测试目录，避免把后端源码作为网站静态文件发布。公开 GitHub 仓库中的源代码本身仍可被查看，因此所有私人值必须留在 Vercel 环境变量中，不能依靠隐藏目录保护秘密。

### `POST /api/session`

首次登录发送 `Authorization: Bearer <Google ID token>`，可用空 JSON `{}`。成功后设置上述 HttpOnly Cookie，返回 `{ "name": "…", "email": "…", "exp": 1234567890 }`；这里的 `exp` 是网站会话到期时间，而非 Google token 到期时间。

恢复时发送无 Authorization 的 `POST`，携带 Cookie 和 `{}`；未登录返回 401，前端正常显示 Google 登录。退出时发送 `{ "action": "signout" }`，服务端清除当前浏览器分区内的 Cookie，前端同时清除文档、译文及预览。恢复和退出均须来自配置的 origin。示例在网站页面内执行：

```javascript
const apiBase = 'https://<项目域名>';
const session = await fetch(`${apiBase}/api/session`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
});
// 退出时将 body 改为 JSON.stringify({ action: 'signout' })。
```

受保护接口也兼容现有 Google Bearer 请求，但前端只在首次交换时发送它；显式传入无效或过期 Bearer 时拒绝请求，不回退到 Cookie。不能把 Google token 写入 localStorage、URL 或日志。

### `POST /api/upload`

仅管理大于 2 MiB、最多 10 MiB 的 PDF。浏览器先解析实际 PDF，拒绝损坏、加密、空文档及超过 100 页的文件；用户同意并点击翻译后才发起上传。此接口只接收小 JSON，不将大 PDF 经 Vercel 转发，因此不触及 Vercel 的 4.5 MB 请求体上限。

| 操作 | JSON 请求体 | 成功响应 |
| --- | --- | --- |
| 创建 | `{ "action": "start", "sizeBytes": 10485760, "pageCount": 20 }` | `{ "fileToken": "…", "uploadUrl": "…" }` |
| 检查 | `{ "action": "status", "fileToken": "…" }` | `{ "ready": true }` 或 `{ "ready": false }` |
| 清理 | `{ "action": "delete", "fileToken": "…" }` | `{ "deleted": true }` |

上述请求均携带网站 Cookie。`fileToken` 有效 1 小时，签名绑定已验证所有者、随机文件名、声明的字节数和页数。后端仅接受 Google 指定上传端点，并在翻译前核对 Google 返回的文件名、MIME、字节数及 `ACTIVE` 状态；不重新下载大文件解析页数，服务端页范围受已签名声明约束。

`uploadUrl` 是只授权此次上传的临时能力 URL，不能上传任意项目文件，不含 Gemini API key。浏览器直接发送原始文件；不要添加 API key、Google ID token 或网站 Cookie，也不要记录、持久保存或分享该 URL。以下片段假设 `file` 已在浏览器通过上述检查，`started` 为创建操作返回值：

```javascript
const uploaded = await fetch(started.uploadUrl, {
    method: 'POST',
    credentials: 'omit',
    headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0'
    },
    body: file
});
if (!uploaded.ok) throw new Error('PDF upload failed');
// 继续请求 action: 'status'，ready 为 true 后再提交 fileToken 翻译。
// 成功、停止或失败后在 finally 中请求 action: 'delete'。
```

### `POST /api/translate`

请求头：`Content-Type: application/json`；前端使用 `credentials: 'include'` 携带网站 Cookie。

最多 2 MiB 的兼容 inline 请求：

```json
{
    "pdfBase64": "PDF 的纯标准 base64，不含 data URL 前缀",
    "targetLanguage": "zh-CN",
    "startPage": 1,
    "endPage": 5
}
```

大文件完成上传后用凭证替代 `pdfBase64`：

```json
{
    "fileToken": "创建上传时返回的凭证",
    "targetLanguage": "zh-CN",
    "startPage": 1,
    "endPage": 5
}
```

目标语言支持 `zh-CN`、`en`、`ja`、`ko`、`fr`、`de`、`es`。页码从 1 开始，包含起止页；终止页超过文档总页数时自动缩小，起始页越界则返回 400。每批最多 5 页，文档最多 100 页且不得加密。inline 路径由后端解析 PDF 校验；大文件路径使用上传时的签名范围及 Google 文件元数据，未就绪返回 409 `UPLOAD_NOT_READY`。原始 JSON 总大小仍最多 3 MiB，不支持压缩请求体。每批通过 inline PDF 或 `fileData` 配合 `documentMetadata` 指定页范围及 `PAGE_IMAGE` / `PAGE_TEXT` 内容层。

成功响应：

```json
{
    "text": "翻译后的 Markdown",
    "complete": true,
    "finishReason": "STOP",
    "startPage": 1,
    "endPage": 5,
    "pageCount": 20,
    "model": "gemini-3.5-flash-lite"
}
```

`complete` 只在 Gemini 返回 `STOP` 且有可见文本时为 `true`。`MAX_TOKENS` 会保留已生成文本并返回 `complete: false`，前端应标记为未完成并缩小页数重试。安全拦截、空结果、速率限制和超时分别返回明确错误。模型的 thought 部分被排除。按批次串行请求，网站会话到期后重新登录；上传凭证到期后重新上传。

## 数据与限制

本站后端不将 PDF、翻译、Google ID token、Cookie 或上传能力 URL 写入文件、数据库或应用日志。Google ID token 仅在登录交换时使用；浏览器持久保存的是 HttpOnly 网站会话 Cookie。PDF 内容会发送到 Google Gemini API，Google 的处理方式由所使用账号、计费方案和相关条款决定。用户关闭请求后，后端会尽力取消上游调用；已开始的 Google 处理或计费未必可撤销。

最多 2 MiB 的 inline 请求不创建 Files API 文件。更大的 PDF 直接上传到 Google 临时 Files 存储，前端在结束、停止或失败后请求删除；关闭页面、断网或清理失败时，Google 文件可能保留至自动到期，最长 48 小时。Files API 临时存储本身免费，翻译仍消耗项目模型额度。默认不配置 Gemini 显式缓存。

Cookie 鉴权必须同时具备有效的加密会话和允许列表内的 Origin；CORS 不是身份验证。无 Origin 的服务端调用仅可使用有效 Google Bearer，不可通过 Cookie 恢复。退出清除当前分区内的 Cookie；需要使所有旧会话失效时，轮换 `OWNER_SESSION_SECRET` 并重新部署。

## 本地运行与验证

在此目录使用 Node.js 24：

```powershell
npm ci
Copy-Item .env.example .env
# 在本地编辑 .env 后运行；未填配置时仍可检查关闭状态。
npm run dev
```

本地 API 为 `http://127.0.0.1:8787`；个人网站仍可在仓库根目录用 `python -m http.server 8000` 预览。

```powershell
npm test
```

前端会话回归测试在仓库根目录运行 `node --test tests/translator-client.test.cjs tests/translator-session.test.cjs`。后端测试在 Google 验证器边界注入合成数据，覆盖账户拒绝、会话篡改与到期、Origin、上传凭证及文件元数据、PDF 限制、原始流大小、Gemini 截断/错误/取消。模拟测试不能代替真实验收：在 HTTPS 网站内登录、刷新恢复、退出后确认 401，再用有效 10 MiB PDF 验证 Google 直传、就绪、实际翻译及删除；同时检查 2 MiB inline 路径仍可用。不将模拟通过描述为真实登录或已上线。

实现参考：[Google 后端 ID token 验证](https://developers.google.com/identity/sign-in/web/backend-auth)、[Gemini 文档处理](https://ai.google.dev/gemini-api/docs/document-processing)、[Gemini Files API](https://aistudio.google.com/docs/files)、[DocumentMetadata](https://googleapis.github.io/js-genai/release_docs/interfaces/types.DocumentMetadata.html)、[Vercel Node.js](https://vercel.com/docs/functions/runtimes/node-js)、[禁用 Node helpers](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration)、[Vercel 请求体限制](https://vercel.com/docs/functions/limitations#request-body-size)、[Vercel 最大执行时间](https://vercel.com/docs/functions/configuring-functions/duration)。
