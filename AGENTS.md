# AGENTS.md

本文件适用于整个仓库，为 Codex 等开发助手提供项目上下文和工作约定。

## 项目概况

- 本仓库是 `furonglin.github.io`，用于 Furong Lin 的 GitHub Pages 学术个人网站，面向博士导师、研究岗位和学术合作者。
- `index.html` 是网站入口；`assets/styles.css` 管理样式，`assets/site.js` 管理中英文切换，`assets/favicon.svg` 为站点图标。
- `assets/Furong_Lin_CV.pdf` 是用户提供的公开简历副本，更新时替换此文件并保留链接路径。
- 页面包括个人介绍、研究兴趣、进行中的研究、经历与教育、技术工具和联系方式，支持中英文切换。
- 个人网站仍为原生静态页面，直接打开 HTML 可预览；私人工作区和 Google 登录需要通过 HTTP/HTTPS 访问。
- `account/index.html` 是所有者工作区；`assets/pdf-translator.js`、`assets/pdf-translator.css` 提供私人 PDF 阅读与翻译界面。
- 独立后端位于 `services/pdf-translator/`，使用 Vercel Node.js 24 Functions、Google ID token 验证及 Gemini API，不迁移 GitHub Pages 网站。
- 个人信息以用户提供的最新资料为准，不虚构个人经历、成果、论文、雇主、作品或联系方式。
- MSc 预计于 2026 年 12 月完成，用户要求暂不展示最终成绩；VR Lab 经历应写为科研志愿者，不暗示正式研究职位。
- 无人机项目仍处于原型探索和实验设计阶段；候选实验方向不应被表述为已验证结果，研究示意图不能充当真实实验截图。

## 修改约定

- 默认使用中文与用户沟通，简要说明实际修改和验证结果。
- 修改前阅读相关代码和工作区状态，保留用户已有改动。
- 小范围调整优先沿用现有原生静态网站结构；新增依赖或框架应服务于明确的任务需求。
- 文件使用 UTF-8 编码，保持现有四空格缩进和周围代码风格，避免无关格式化。
- 未要求重新设计时，沿用现有深色背景、渐变强调色和卡片布局。
- 主题颜色优先复用 `:root` 中的 CSS 变量；布局调整需兼顾桌面和手机宽度，现有主要响应式断点为 `860px`。
- 使用语义化 HTML，保持按钮和链接可通过键盘操作，避免破坏标题层级、锚点或文字可读性。

## 中英文内容与切换

- 面向访客的文案应同步维护英文和中文版本，确保两种语言的信息一致。
- HTML 初始内容为英文，可在 JavaScript 不可用时完整阅读；用户选择的语言通过 `localStorage` 中的 `site-language` 保存，存储不可用时仍可切换。
- 需翻译的纯文本元素使用 `data-zh="中文文案"`，英文直接写在元素内容中。脚本保存初始英文，再通过 `textContent` 切换。
- `data-zh` 元素内不要嵌套链接、图标或其他结构；需要保留的子元素应与翻译用的 `<span>` 分开。
- `aria-label` 使用 `data-zh-aria-label` 提供中文；页面 `<title>` 和描述元标签同样需要更新两种语言。
- 语言按钮为 `btn-en` 和 `btn-zh`，使用 `.active` 和 `aria-pressed` 同步状态。新增内容无需维护区块 ID 清单或依赖中英文块的 DOM 顺序。
- 切换时需同步按钮的激活状态和 `<html lang>`，英文为 `en`，中文为 `zh-CN`。

## 私人工作区

- 个人网站无需登录即可浏览。只有后端成功验证获准的 Google 账户后，才可显示 `#private-workspace` 内的 PDF 功能。
- 前端隐藏界面不是访问控制；首次登录须在后端验证 Google 签名、受众、有效期、邮箱验证状态和账户白名单。之后每次 `/api/session` 恢复、`/api/upload` 和 `/api/translate` 请求都必须验证网站会话的加密认证、有效期及当前身份配置；显式传入无效 Google Bearer 时不得回退到 Cookie。
- 允许的账户仅通过后端环境变量配置，不写入前端、示例文件或公开文档；缺少身份配置时应拒绝访问。
- `assets/translator-config.js` 只保存公开的后端 HTTPS origin。Google ID token 只保存在页面内存，不能写入 localStorage、URL 或日志。
- 网站会话最长 30 天，仅使用 `__Host-owner_session` Cookie，保留 `HttpOnly; Secure; SameSite=None; Partitioned; Path=/`。前端请求使用 `credentials: 'include'`；Cookie 鉴权还必须校验允许的 Origin。`OWNER_SESSION_SECRET` 只放在后端秘密配置中，轮换后旧会话和上传凭证失效。真实登录验收使用支持分区 Cookie 的 Chromium 浏览器及 HTTPS 网站。
- Gemini 和部署平台密钥只能放在服务端秘密配置中；禁止提交真实密钥、`.env`、`.vercel` 或含秘密的日志。
- `_config.yml` 排除后端和测试目录，避免 GitHub Pages 将其作为静态网站文件发布；这不能代替源码内不含秘密的要求。
- 本站默认不持久保存文档；只有用户明确点击翻译并同意处理后，才发送 PDF 至 Google Gemini。大于 2 MiB 的 PDF 直接上传至 Google 临时 Files 存储，完成、停止或失败后请求删除；清理未成功时可能保留至自动到期，最长 48 小时，不得宣称全链路零存储。
- PDF 最大 10 MiB、100 页，每次请求最多翻译 5 页。保留最多 2 MiB 的 inline 兼容路径及 3 MiB 原始 JSON 上限；大文件使用所有者授权的单文件上传能力 URL，不经 Vercel 转发文件正文，也不向前端暴露 Gemini key。上传 URL 和凭证仅用于本次请求，不放入地址栏、本站查询参数、localStorage 或日志。
- 大文件实际格式、加密状态及页数由浏览器解析；后端验证绑定所有者、大小、页数、文件名和有效期的上传签名，翻译前核对 Google 文件元数据与就绪状态。服务端只接受受验证的上传凭证，不接受任意文件 URI；不得宣称后端独立重新解析了直传大文件。结果截断时必须显示不完整，不能标记为成功完成。
- 保留 Vercel 的 `NODEJS_HELPERS=0` 配置和原始请求体大小检查；不得以 CORS 或前端提供的邮箱代替身份验证。

## 本地预览与验证

直接用浏览器打开 `index.html` 即可预览。如已安装 Python，也可以在仓库根目录运行：

```shell
python -m http.server 8000
```

然后访问 <http://localhost:8000>，使用 `Ctrl+C` 停止服务。

涉及页面内容、结构、样式或交互时，按改动范围检查：

1. 默认英文显示正常，切换中文再切回英文，各相关区块无缺失或语言混用。
2. 桌面和手机宽度下布局正常，无横向溢出，按钮和文字可用。
3. 相关页内锚点、外部链接和邮箱链接指向正确目标。
4. 修改交互脚本后，检查浏览器控制台是否出现相关错误。

修改脚本后运行 `node --check assets/site.js`；提交工作结果前运行 `git diff --check`。检查相对资源与 CV 链接、页内锚点，以及 JSON-LD 是否仍有效。纯文档改动只需检查文档内容与格式，无需启动页面或新增测试。无法执行的检查应如实说明，不声称已验证或已上线。

修改私人工作区后运行 `node --check assets/pdf-translator.js` 和 `node --test tests/translator-client.test.cjs tests/translator-session.test.cjs`；后端修改在 `services/pdf-translator/` 中运行 `npm test`。模拟测试不能替代真实 Google 登录、Cookie 恢复与退出、10 MiB 直传清理及真实 Gemini 翻译验收。

## 部署相关

- 保持网站可通过 GitHub Pages 静态托管，新增功能时不要假设服务器会执行后端代码。
- 如新增图片、样式或脚本文件，优先使用相对路径，并确保路径大小写与文件名一致。
- 不在前端代码或仓库中写入密钥、令牌或其他敏感配置。
- 本地改动不代表已发布；提交、推送和部署按用户任务要求执行，线上状态以实际部署结果为准。
