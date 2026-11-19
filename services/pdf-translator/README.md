# 私人 PDF 翻译 API

这是独立部署到 Vercel 的 Node.js 后端。学术网站及翻译页面继续由 GitHub Pages 托管；后端项目根目录必须设为 `services/pdf-translator`，不会构建或替换个人网站。

后端只允许已配置的一个 Google 邮箱。每次会话检查与翻译都重新使用 `google-auth-library` 验证 Google ID token 的签名、签发者、受众和有效期，再检查 `email_verified === true` 与规范化邮箱完全一致。可选的 Google `sub` 进一步锁定同一账号。缺少身份配置或 Gemini key 时拒绝翻译。

## 配置

在 Vercel 项目的 Environment Variables 中设置以下变量。真实值不要提交到 Git，也不要填到 GitHub Pages 的前端代码中。

| 变量 | 用途 |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google Cloud 中 **Web application** OAuth 2.0 Client ID。Client ID 本身是公开值，会由 `/api/config` 返回。无需 Client Secret。 |
| `ALLOWED_GOOGLE_EMAIL` | 唯一允许登录的完整 Google 邮箱；比较前会 trim 并转为小写。必须配置。 |
| `ALLOWED_GOOGLE_SUB` | 可选；该 Google 账号 ID token 中的稳定 `sub`。配置后邮箱和 `sub` 均须匹配。 |
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
3. 部署后检查 `GET https://<项目域名>/api/config`。身份配置齐全后 `signInReady` 为 `true`，设置免费层密钥且模型在允许名单中后 `translationReady` 为 `true`。这些布尔值只表示应用配置就绪，实际登录、翻译和 Google 项目计费状态需分别验证。
4. 将前端的后端基础 URL 配置为此项目的 HTTPS origin，再使用自己的 Google 账号做一次真实登录和小 PDF 翻译。

本项目是 API 服务，根路径 `/` 只显示通用服务说明，不显示翻译功能。函数最大执行时间 300 秒，单次 Gemini 请求上限 240 秒。配置变化需要重新部署；本地改动不代表已上线。

## API

所有 JSON 错误统一为 `{ "error": { "code": "稳定错误代码", "message": "安全说明" } }`。所有响应使用 `Cache-Control: no-store`，不返回 Google/Gemini 原始错误。

### `GET /api/config`

公开仅返回登录必需的 `googleClientId`、文件和页数限制，以及 `signInReady`、`translationReady` 状态。不会返回允许邮箱、Google `sub`、密钥或服务端模型配置；登录客户端 ID 本身是公开应用编号。

GitHub Pages 的 `_config.yml` 应排除 `services/` 和测试目录，避免把后端源码作为网站静态文件发布。公开 GitHub 仓库中的源代码本身仍可被查看，因此所有私人值必须留在 Vercel 环境变量中，不能依靠隐藏目录保护秘密。

### `POST /api/session`

请求头：`Authorization: Bearer <Google ID token>`。无需请求体。成功仅返回已验证账号的 `{ "name": "…", "email": "…", "exp": 1234567890 }`；不设置持久会话 cookie，不签发替代 token。

### `POST /api/translate`

请求头：`Authorization: Bearer <Google ID token>`、`Content-Type: application/json`。

```json
{
    "pdfBase64": "PDF 的纯标准 base64，不含 data URL 前缀",
    "targetLanguage": "zh-CN",
    "startPage": 1,
    "endPage": 5
}
```

目标语言支持 `zh-CN`、`en`、`ja`、`ko`、`fr`、`de`、`es`。页码从 1 开始，包含起止页；终止页超过文档总页数时自动缩小，起始页越界则返回 400。缩小后的范围每批最多 5 页。PDF 必须不超过 2 MiB、100 页且未加密；原始 JSON 总大小最多 3 MiB，不支持压缩请求体。每批通过 inline PDF 和同级 `documentMetadata` 指定页范围及 `PAGE_IMAGE` / `PAGE_TEXT` 内容层。

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

`complete` 只在 Gemini 返回 `STOP` 且有可见文本时为 `true`。`MAX_TOKENS` 会保留已生成文本并返回 `complete: false`，前端应标记为未完成并缩小页数重试。安全拦截、空结果、速率限制和超时分别返回明确错误。模型的 thought 部分被排除。建议按批次串行请求，并在 ID token 到期时重新登录。

## 数据与限制

此服务不将 PDF、翻译或 Google ID token 写入文件、数据库或应用日志；请求处理期间仅在内存使用。PDF 内容会发送到 Google Gemini API，Google 的处理方式由所使用账号、计费方案和相关条款决定。用户关闭请求后，后端会尽力取消上游调用；已开始的 Google 处理或计费未必可撤销。

默认不配置 Gemini 显式缓存，也不创建 Files API 文件。CORS 只允许配置的浏览器 origin，来自无 Origin 的服务端请求同样必须通过 Google 鉴权。

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

测试使用真实鉴权 helper，并仅在 Google 验证器边界注入合成测试数据；覆盖拒绝其他账号、未验证邮箱、缺少配置、认证失败不 fallback、PDF 格式与页数、原始流大小限制、真实 HTTP chunked 413、Gemini 截断/拦截/错误/超时/取消。测试没有使用真实 Google/Gemini 凭据，不能代替部署后的真实登录与翻译验证。

实现参考：[Google 后端 ID token 验证](https://developers.google.com/identity/sign-in/web/backend-auth)、[Gemini 文档处理](https://ai.google.dev/gemini-api/docs/document-processing)、[DocumentMetadata](https://googleapis.github.io/js-genai/release_docs/interfaces/types.DocumentMetadata.html)、[Vercel Node.js](https://vercel.com/docs/functions/runtimes/node-js)、[禁用 Node helpers](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration)、[Vercel 最大执行时间](https://vercel.com/docs/functions/configuring-functions/duration)。
