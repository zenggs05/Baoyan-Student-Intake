# 保研全程陪跑网站 v2 · 架构与接口约定

> 本文件是各模块开发的唯一依据。改接口必须先改本文件。
> 项目根：`F:\personal\保研辅导\06_网站`（Git 仓库，对应 GitHub `zenggs05/Baoyan-Student-Intake`，**该仓库是公开的**）。
> Node：22.x（本机如未把 node 加入 PATH，运行前先把 Node 22 所在目录加入 PATH）。npm 镜像写在项目 `.npmrc`，**不要改全局 npm 配置**。

## 0. 目标

1. **学员信息采集**（原站功能，重写为有源码的版本）：分步填写、本地保存、JSON 备份；**重做 Word 导出与 PDF 导出的排版**，去掉原版内嵌的 14MB 字体。
2. **资料库**：把 `03_对外产品_脱敏` 的资料做成网页，公开展示目录、售卖页、试读；正文锁定。
   - **密钥**：作者在后台给某个（或几个）产品生成密钥发给买家。密钥**自生成起 30 分钟有效**。有效期内，买家可以在线阅读、**下载 PDF**；过期后资料重新锁定。
   - **陪跑学员账号**：作者在后台给全程陪跑学员开账号（用户名 + 密码 + 到期日）。学员登录后可以**一直在线查看**，但**不能下载**。
3. **管理后台**：作者登录后可以快速发码、查看和撤销有效密钥，管理学员账号。

## 1. 技术栈与部署

- **Cloudflare Workers**：一个 Worker 同时提供静态资源（Workers Static Assets）和 `/api/*` 接口。数据存在 **Workers KV**，密钥爆破防护用 **Workers Rate Limiting** binding。
- 前端用原生 JS（不用框架），esbuild 打包；Word 导出用 `docx@9`，Markdown 渲染用 `markdown-it@14`，本地生成 PDF 用 `puppeteer-core` 驱动本机 Chrome，`pdf-lib@1` 只在构建脚本里用（合并封面、预留授权标识，见 §5.4）；浏览器端不加载 pdf-lib。
- 本地开发：`npx wrangler dev --port 8787`，KV 存在本地 `.wrangler/state`。
- **公开仓库红线**：资料正文、PDF、`.content/`、`dist/`、`.dev.vars`、`.wrangler/` 一律 gitignore。正文只存在 KV 里，不进 Git，也不进静态资源。
- 中国大陆访问：`*.workers.dev` 在大陆经常打不开，正式使用需要绑定自定义域名（部署时由作者决定）。代码不依赖任何境外 CDN，字体只用系统字体。

## 2. 目录结构与归属

```
06_网站/
├─ docs/ARCHITECTURE.md            本文件
├─ legacy/                         原线上版本（只读参考：index.html / app.css / app.js）
├─ reference/                      原版应用代码（已解码中文，压缩格式）：
│   ├─ legacy_app_core.min.js        表单 schema、校验、存储、文档模型 Wt()
│   └─ legacy_app_ui.min.js          PDF 导出 Hu()、下载 Ja()、全部界面逻辑
├─ src/
│   ├─ shared/                     共享样式与工具（tokens.css、ui.js、api.js）
│   ├─ intake/                     学员信息采集（路由 /intake/）
│   ├─ site/                       首页（路由 /）
│   ├─ library/                    资料库：目录、试读、阅读器（路由 /library/）
│   ├─ login/                      学员登录（路由 /login/）
│   ├─ admin/                      管理后台（路由 /admin/）
│   └─ worker/                     Worker：API、鉴权、KV
├─ scripts/
│   ├─ build-site.mjs              打包前端到 dist/（已写好，见 §6）
│   ├─ catalog.config.mjs          产品定义（哪些 md 属于哪个产品、价格、卖点）
│   ├─ build-content.mjs           md → HTML 片段 + 清单 + 公开页
│   ├─ build-pdf.mjs               每个产品生成排版好的 PDF
│   └─ upload-content.mjs          写入 KV（--local / --remote）
├─ tests/                          node --test 单元测试 + e2e
├─ .content/                       (gitignored) 内容构建产物
├─ dist/                           (gitignored) 前端构建产物 = Worker 静态资源目录
└─ wrangler.toml
```

## 3. 数据模型（KV）

KV 中所有时间都是 Unix 毫秒时间戳。

| Key | Value | TTL |
|---|---|---|
| `manifest` | 内部清单 JSON，见 §5.2 | 无 |
| `c:<productId>:<docId>` | 文档 HTML 片段（UTF-8 字符串） | 无 |
| `pdf:<productId>` | 产品 PDF（二进制，带授权标识占位符，见 §5.4） | 无 |
| `pdfstamp:<productId>` | `{v:1, size, code:[字节偏移], day:[字节偏移]}`：PDF 里授权标识占位符的位置，由 build-pdf 生成 | 无 |
| `key:<CODE>` | `{code, products:[id...], label, createdAt, expiresAt, maxUses, uses, revoked, lastUsedAt?, revokedAt?}`；KV metadata `{products, label, expiresAt, uses, maxUses, createdAt, revoked}`，供后台列表使用 | `ceil((expiresAt-now)/1000)`，最小 60；撤销后改为 60 |
| `revoked:<CODE>` | 撤销墓碑 `{code, revokedAt}`，metadata `{revokedAt}`。**判断是否撤销以它为准**，只有撤销接口会写它 | 到密钥原定的 `expiresAt` 为止，最小 60 |
| `user:<username>` | `{username, displayName, pwHash, salt, iter, products:"all"或[id...], expiresAt, disabled, createdAt, lastLoginAt, pwSetAt}`；metadata `{displayName, expiresAt, disabled, createdAt, lastLoginAt, products}`（metadata 超过约 900 字节时去掉 `products`，列表接口改为读整条记录）。**只由管理接口写入**；`lastLoginAt` 只在旧记录里有，新的登录时间记在 `seen:<username>` | 无 |
| `seen:<username>` | 最近一次登录时间（毫秒字符串），metadata `{lastLoginAt}`。登录时写这里，不再改 `user:` | 无 |
| `sess:<token>` | `{type:"key"或"student"或"admin", sub, products, displayName?, label?, pwv?, iat, exp}`，其中 key 会话的 `sub` 是密钥 CODE，学员会话的 `sub` 是 username。学员会话存 `displayName` 和 `pwv`（登录时账号的 `pwSetAt`），管理员会话存 `label:"管理员"`，**key 会话不存 label** | 到 `exp` 为止 |

**买家备注（`key.label`）只给作者自己看**：它只存在 `key:<CODE>` 记录和 metadata 里，只通过 `/api/admin/keys` 返回；不写入会话，不通过 `/api/me`、`/api/redeem` 返回给买家，也不进入水印。水印只用密钥 CODE，作者凭 CODE 在后台查到对应的备注。

**学员密码重置**：重置时更新 `pwSetAt`。账号的 `pwSetAt` 晚于会话的 `pwv`（没有 `pwv` 的旧会话用 `iat`）时视为失效（401「密码已被重置」），所以重置密码会让旧登录全部下线；在还没看到重置的节点上用旧密码新开的会话，等该节点看到新记录后同样失效。

**KV 最终一致性**：其他节点最长约 60 秒内可能读到旧值。约定如下：
- 读取路径（兑换、登录、阅读、下载）**不回写任何鉴权字段**：撤销只看 `revoked:<CODE>` 墓碑，登录不改写 `user:<u>`。所以旧缓存最多让撤销、停用、重置**延迟**生效，不能把它们覆盖回去。
- 鉴权读取（`key:`、`revoked:`、`user:`）带 `cacheTtl: 30`（KV 允许的最小值）。后台界面注明「撤销、停用、重置密码最长约 1 分钟生效」。
- 已知限制（未处理）：`maxUses` 的计数是先读后写，并发或跨节点兑换可能超过上限；兑换时回写的 `key:<CODE>` 可能带着旧的 `uses`。需要严格计数时改用 Durable Object 或 D1。

**产品权限展开**：`products` 中的 `"P4"` 自动包含全部 `P3-*`（由清单中的 `includes` 字段声明，可传递）；`"all"` 表示全部可售产品（`forSale!==false` 且非 `studentOnly`），学员账号额外包含全部 `studentOnly` 产品（即 `KIT`）。**管理员会话展开为清单中的全部产品**（含 `KIT` 和不售卖的产品），见 §4.4。

## 4. API（Worker）

通用约定：
- 请求和响应都是 JSON（下载接口除外）。
- 错误统一返回 `{error: "人类可读的中文"}`，状态码 400 / 401 / 403 / 404 / 429；另有 405（路径存在但请求方法不对）和 500（未预期的异常，提示稍后再试）。
- 所有 JSON 响应都带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`X-Robots-Tag: noindex`。
- 会话 Cookie 名为 `bys`，属性 `HttpOnly; Secure; SameSite=Lax; Path=/`，`Max-Age` 取会话剩余秒数。在 `http://localhost` 和 `127.0.0.1` 下开发时，浏览器允许 Secure Cookie。
- 所有修改类请求（POST/DELETE）必须校验 `Origin` 与请求的 Host 一致，以此防 CSRF。
- `token` 由 32 字节随机数编码为 base64url。

### 4.1 公开与会话接口
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/catalog` | – | 公开清单：`{products:[{id,title,subtitle,price,priceNote,sellingPoint,docCount,docs:[{id,title}],preview:true/false,includes,studentOnly:true/false}]}`，不含正文。未登录和 key 会话只看到可售产品；`studentOnly` 产品（`KIT`）只在当前会话能阅读它时出现（学员、管理员） |
| `GET /api/me` | – | `{session:null}`；或 `{session:null, notice:"…"}`（浏览器带着 Cookie 但会话已失效时，`notice` 用中文说明原因，例如密钥已撤销、账号已停用；会话已彻底失效时同时清除 Cookie）；或 `{session:{…}}`，见下方「会话形态」 |
| `POST /api/redeem` | `{code}` | 成功时设置 Cookie，返回 `{session}`（形态同 `/api/me`）。归一化规则：全角转半角，转大写，去掉空格和 `-`，`O→0`、`I/L→1`。错误情况：不存在或已过期返回 404「密钥无效或已过期」；已撤销返回 403「该密钥已被撤销」；`uses>=maxUses` 返回 403「该密钥已达到使用次数上限」。同一浏览器在已用该密钥解锁的情况下再次输入，不会再消耗次数。限流：每个 IP 每分钟 10 次，超出返回 429 |
| `POST /api/login` | `{username,password}` | 学员登录，成功时设置 Cookie，返回 `{session}`。会话 `exp = min(now+7天, user.expiresAt)`。账号停用或已到期返回 403。限流同上 |
| `POST /api/logout` | – | 清除 Cookie 并删除会话，返回 `{ok:true}` |
| `GET /api/doc/:productId/:docId` | – | 返回 `{html, title, productId, docId, productTitle, toc:[{id,text,level}], watermark:{line1,line2}}`。需要有效会话且有该产品权限，否则 401/403。key 会话每次请求都要复查 `revoked:<CODE>` 和 `key:<CODE>`（已撤销返回 403，直到密钥原定的到期时间；密钥不存在或已过期返回 401）；学员会话每次请求都要复查 `user:<u>` 是否被删除、停用、到期或重置过密码 |
| `GET /api/download/:productId` | – | **仅限 key 会话**。返回 PDF 二进制，**服务端在返回前把密钥 CODE 和日期写进每页的授权标识和 XMP 元数据**（按 `pdfstamp:<p>` 记录的位置改写占位符，见 §5.4），所以无论点按钮、直接打开地址还是在开发者工具里另存，拿到的都是带标识的文件；缺少或对不上 `pdfstamp:<p>` 时拒绝下载（404「这份资料的 PDF 正在更新…」），不发不带标识的文件。头部包含 `Content-Type: application/pdf`、`Content-Disposition: attachment; filename="<id>.pdf"; filename*=UTF-8''<产品名>.pdf`、`Cache-Control: no-store`、`X-License-Code: <CODE>`。学员会话返回 403「陪跑账号仅支持在线查看」；管理员会话也返回 403 |

所有 `/api/doc` 和 `/api/download` 响应都带 `Cache-Control: no-store` 与 `X-Robots-Tag: noindex`。

**会话形态**（`/api/me`、`/api/redeem`、`/api/login` 返回的 `session`）：

| 字段 | key 会话 | 学员会话 | 管理员会话 |
|---|---|---|---|
| `type` | `"key"` | `"student"` | `"admin"` |
| `code` | `XXXX-XXXX-XXXX`（用于水印和界面） | – | – |
| `username` | – | 用户名 | – |
| `label` | 恒为 `""`（**不返回买家备注**；字段仅为兼容保留） | 同 `displayName` | `"管理员"` |
| `displayName` | `""` | 学员称呼 | `"管理员"` |
| `products` | 已展开的 id | 已展开的 id（含 `KIT`） | 全部产品 id |
| `expiresAt` | `min(会话 exp, 密钥 expiresAt)` | `min(会话 exp, 账号 expiresAt)` | 会话 exp |
| `accountExpiresAt` | – | 账号到期时间 | – |
| `canDownload` | `true` | `false` | `false` |

前端只用 `code`（key 会话）和 `displayName`/`username`（学员会话）显示身份，不读 `label`。

水印 `watermark`：key 会话 `line1="LICENSED <CODE>"`、`line2="<日期> · 仅限购买者本人学习使用"`；学员会话 `line1="<称呼> @<username>"`、`line2="<日期> · 陪跑学员专用 · 请勿转发"`；管理员会话 `line1="管理员预览"`、`line2="<日期>"`。

### 4.2 管理接口（需 admin 会话）
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/admin/login` | `{password}` | 与环境变量 `ADMIN_PASSWORD` 做恒定时间比较，成功后建立 admin 会话（12 小时），返回 `{session:{type:"admin",label:"管理员",displayName:"管理员",products:[],expiresAt,canDownload:false}}`（这里的 `products` 为空，之后 `/api/me` 返回展开后的全部产品）。未配置 `ADMIN_PASSWORD` 时返回 403。限流：每 IP 每分钟 5 次（每次尝试计 `RL_AUTH` 的 2 次） |
| `GET /api/admin/products` | – | `{products:[{id,title,subtitle,price,priceNote,forSale,studentOnly,includes,docCount,pdf}], builtAt, version}`，即内部清单中的全部产品 |
| `POST /api/admin/keys` | `{products:[id], label?, minutes?=30, maxUses?=3}` | 返回 `{code:"XXXX-XXXX-XXXX", expiresAt, products, label, maxUses, minutes, createdAt}`。minutes 取值 1–1440（1 分钟只用于测试，界面默认 30）；maxUses 取值 1–100；`label` 去首尾空格后最多 60 字（界面限 40 字），**仅后台可见**；`studentOnly` 产品不能发码（400） |
| `GET /api/admin/keys` | – | `{keys:[{code,products,label,expiresAt,uses,maxUses,createdAt}]}`：未过期、未撤销的密钥，按 `createdAt` 倒序（KV list `key:` 前缀，只读 metadata；再用 `revoked:` 前缀排除已撤销的） |
| `POST /api/admin/keys/:code/revoke` | – | 写入墓碑 `revoked:<CODE>`（保留到密钥原定的到期时间），再把 `key:<CODE>` 标为 revoked 并把 TTL 缩短为 60 秒，返回 `{ok:true, code}`；找不到返回 404。最长约 1 分钟在所有节点生效 |
| `GET /api/admin/students` | – | `{students:[{username,displayName,products,expiresAt,disabled,createdAt,lastLoginAt}]}`，按 `createdAt` 倒序，不含密码哈希。`lastLoginAt` 取 `seen:<u>` 与旧记录里 `lastLoginAt` 中较晚的一个 |
| `POST /api/admin/students` | `{username, displayName?, expiresAt?, products?:"all"或[...]}` | 返回 `{username, password, displayName, expiresAt, products}`，明文密码只在这里返回一次。`expiresAt` 可以是毫秒时间戳或 `YYYY-MM-DD`（按北京时间当天 23:59:59 结束），省略时为当年（已过则次年）10 月 31 日；`products` 省略时为 `"all"`；`displayName` 省略时用用户名 |
| `POST /api/admin/students/:u/reset` | – | 返回 `{password, username}`；该学员已有的登录全部失效 |
| `POST /api/admin/students/:u/disable` 和 `/enable` | – | `{ok:true}` |
| `DELETE /api/admin/students/:u` | – | `{ok:true}` |

- **密钥 CODE**：12 位 Crockford Base32（字符集 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`），用 `crypto.getRandomValues` 生成（60 bit），显示时写成 `XXXX-XXXX-XXXX`。
- **学员密码**：系统生成 10 位，字符集 `abcdefghjkmnpqrstuvwxyz23456789`（只用小写，去掉易混字符，方便手机输入）。哈希用 PBKDF2-SHA256，迭代 10000 次（考虑到 Workers 免费版每次请求 10ms 的 CPU 限制；密码由系统随机生成、熵足够高），16 字节随机盐。
- **用户名**：`^[a-z0-9_]{3,32}$`。

### 4.3 环境与绑定（wrangler.toml）
- `KV`（KV namespace）
- `ASSETS`（静态资源，目录 `./dist`）。`run_worker_first = ["/*", "!/*.js", "!/*.css", "!/*.json", "!/*.png", "!/*.jpg", "!/*.svg", "!/*.ico", "!/*.webp", "!/*.woff2", "!/*.txt", "!/data/*"]`：Worker 先处理 `/api/*` 和所有 HTML 页面（给页面加 `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`、`Permissions-Policy`），打包出的 JS/CSS、图片和 `/data/*` 公开内容不经过 Worker，直接作为静态资源返回
- `RL_AUTH`：Rate Limiting binding（10 次/分钟）。可用时调用 `env.RL_AUTH.limit({key})`，绑定不存在或调用出错时自动跳过
- 机密：`ADMIN_PASSWORD`。本地放在 `.dev.vars`，线上用 `wrangler secret put`

### 4.4 管理员会话
- 管理员登录后（`type:"admin"`，12 小时），**可以在线预览全部产品**：会话的 `products` 展开为清单中的全部产品，包括 `KIT` 和不售卖的产品；`/api/catalog` 也会返回 `KIT`。用途是上线前检查排版和内容。
- `/api/doc` 对管理员放行，水印为「管理员预览 + 日期」；`/api/download` 对管理员返回 403。要体验买家流程（含下载带授权标识的 PDF），在后台给自己发一个测试密钥。
- 前端：资料库顶部显示「当前是管理员身份」状态卡（带「进入管理后台」「退出」）；阅读器顶栏显示「管理员预览」，不显示下载按钮。
- 管理接口（§4.2）只认 admin 会话；同一浏览器兑换密钥或学员登录会替换掉 admin 会话。

## 5. 内容

### 5.1 来源
`CONTENT_ROOT` 默认是与本项目同级的 `../03_对外产品_脱敏`，可用环境变量覆盖。

| 产品 id | 标题 | 价格 | 文档 |
|---|---|---|---|
| `P1` | 保研经验指南 | 29.9 | `P1_保研经验指南/P1_00…P1_15` |
| `P2` | 理工科面试题库 | 49.9 | `P2_理工科面试题库/P2_00…P2_13` |
| `P3-<slug>` | 单校面经复盘·<学校学院> | 59.9 | `P3_单校面经复盘/P3_<学校>_<学院>.md`，每个文件一个产品 |
| `P4` | 多校面经合集 | 169（加答疑版 199） | `P4_多校面经合集/*.md`，加上 `P3_单校面经复盘/公开面经汇编/*.md`；`includes:["P3-*"]` |
| `P5` | DFT 一周入门笔记 | 249 含一周答疑 / 199 纯资料 | `P5_DFT一周入门笔记/*.md` |
| `KIT` | 陪跑学员工具包（不售卖，仅学员可见） | – | `04_服务模板与SOP/` 中的 `T_MAIL`、`T_CV`、`T_PS`、`T_CVPS`、`T_PPT`、`T_MOCK`、`T_PLAN`、`T_RUNALL` |

公开内容：`目录与试读/<P>_售卖页.md`、`<P>_试读.md`、`P3_东南_B级流程试读.md`，以及 `04_服务模板与SOP/服务介绍页/*.md`。

### 5.2 清洗规则（build-content）
1. 删掉每个文件第一行的元信息（以 `产品：` 开头那行）。
2. 删掉 HTML 注释（例如 `<!-- 公开面经补充 BEGIN … -->` 这类标记）。
3. `{{待作者确认:xxx}}` 渲染为 `<span class="todo" title="xxx">待补充</span>`，并记入 `.content/report.md`。
4. 固定免责声明段落改为 `<aside class="disclaimer">`。
5. markdown-it 选项：`html:true, linkify:true`。给 h2、h3 加 id，并抽取为文档目录。
6. 检测内部用语（如「待作者补充」「不单独销售」「来源台账」「Codex」「sale_ready」「内部」等），只在报告里提示，不自动修改。
7. **发布前检查**（`lib-content/leak-gate.mjs`）：把所有公开页（售卖页、试读、服务介绍）和全部锁定正文逐句比对（12 字以上的句子，免责声明不计）。产品自己的售卖页、试读引用自己的正文算「试读」（同一系列、`includes` 包含的产品也算）；其他公开页累计公开某篇正文超过 20% 或 30 句（且至少 5 句）时，从重复最多的页面开始**不发布**；试读合计超过本产品正文 30% 也不发布。被拦下的页面不写进 `.content/public/`，控制台和报告里列出原因；确属有意公开的组合登记在 `catalog.config.mjs` 的 `LEAK_ALLOW`，阈值在 `LEAK_LIMITS`。

**内部清单** `manifest` 的格式：`{version, builtAt, products:[{id,title,subtitle,price,priceNote,sellingPoint,forSale,studentOnly,includes,docs:[{id,title,toc:[{id,text,level}]}],pdf:true}]}`。`docId` 取文件名去掉扩展名后的 ASCII 安全写法（如 `P2_03`、`D1`），P3 和公开汇编文件用 slug。

### 5.3 产物
- `.content/kv/`：`manifest.json`；`c__<p>__<doc>.html`；`pdf__<p>.pdf`；`pdfstamp__<p>.json`（授权标识占位符位置）。
- `.content/public/`：
  - `catalog.json`（与匿名访问 `/api/catalog` 的结果相同，包括 `studentOnly` 字段）。它是静态文件，**不包含 `studentOnly` 产品（`KIT`）**；学员、管理员登录后，前端发现会话里有清单之外的产品，会用 `/api/catalog` 补齐（`ensureProducts`）。
  - `library/<p>/sale.html`（售卖页片段）、`library/<p>/preview.html`（试读片段）；P3 另有系列级的 `library/P3/sale.html`、`preview.html`，单品页面缺失时兜底
  - `services/<code>.html`（服务介绍片段）、`services/index.json`（服务列表）。没通过发布前检查（§5.2-7）的页面不会出现在这里，首页点「详情」时显示「详细说明正在整理中」

  build-site 会把整个目录原样复制到 `dist/data/`。前端通过 `fetch('/data/…')` 读取。这里只能放**公开**内容。
- `upload-content.mjs` 生成 wrangler bulk JSON（PDF 用 `base64:true`，同时上传 `pdfstamp:<p>`；PDF 缺少或对不上位置文件时报错），然后执行 `npx wrangler kv bulk put <file> --binding KV --local|--remote`。

### 5.4 PDF（build-pdf）
用 puppeteer-core 驱动 `C:\Program Files\Google\Chrome\Application\chrome.exe`。
- 版式：A4。依次是封面（产品名、副标题、版本日期、「仅供购买者个人学习使用，禁止转发、转售」）、目录、正文。每篇文档从新的一页开始。
- `displayHeaderFooter`：页眉放产品名，页脚放「第 X 页 / 共 Y 页」。
- 字体：`"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif`。
- **授权标识（服务端写入）**：build-pdf 用 pdf-lib 在每页叠加一行淡色斜向文字 `LICENSED ####-####-#### · ~~~~-~~-~~`（Helvetica，标为 Artifact，不进阅读顺序），并写入同样内容的 XMP 元数据（`dc:rights`）。占位符所在的流不压缩，保存后记下占位符的字节位置，写到 `pdfstamp__<p>.json`。下载时 Worker 只把这些位置的字节改写成 `ABCD-EFGH-JKMN` 和北京时间日期（`src/worker/pdf-stamp.js`），不解析 PDF，几 MB 的文件也只需不到 1 毫秒 CPU，免费套餐可用。CODE 对应的密钥记录可以追溯到具体买家。

## 6. 前端约定

- **build-site.mjs 约定**（已实现）：
  - `src/<app>/*.html` 复制到 `dist/<route>/`（其中 `index.html` 对应路由根）。
  - `src/<app>/*.entry.js` 用 esbuild 打包（esm、splitting、minify，target `es2020 / chrome90 / safari15`），输出为 `dist/<route>/<name>.js`，公共代码进 `dist/_chunks/`。
  - `src/<app>/*.entry.css` 打包为 `dist/<route>/<name>.css`。
  - `.content/public/` 复制到 `dist/data/`。复制用手写的递归 `copyFileSync`：本机 Node 在含中文的路径下调用 `fs.cpSync` 会静默退出，**不要改回 `cpSync`**。
  - 参数：`--out <dir>` 输出到别的目录（测试用），`--only a,b` 只打包部分应用。
  - 路由映射：`site → /`、`intake → /intake/`、`library → /library/`、`login → /login/`、`admin → /admin/`。
- 每个 HTML 都带严格的 CSP meta：
  - 采集页 `connect-src 'none'`，保持原来「数据只在本机处理」的承诺。
  - 其他页面 `connect-src 'self'`。
  - 所有页面都不允许任何外部资源。
- **品牌与联系渠道**：品牌名「保研全程陪跑」不变；顶栏副标题带「公众号「飞鸟想要飞」」。所有购买、预约入口统一写「关注微信公众号「飞鸟想要飞」，后台留言预约或购买」（JS 里用 `src/site/lib/contact.js` 的 `BUY_CHANNEL`，静态 HTML 手写同一句）；首页、资料库、详情页、登录页的页脚都有一行「公众号：飞鸟想要飞」。
- **视觉**：沿用原版的设计语言，见 `src/shared/tokens.css` 与 `legacy/app.css`。藏青 `#172946`、主蓝 `#315eaa`、灰字 `#718097`、边框 `#e4e9f1`、背景 `#f5f7fb`；卡片圆角 12–16px；系统中文字体。**移动端优先**，多数学员在手机微信里打开，`/MicroMessenger/i` 用于判断微信环境。
- **共享模块** `src/shared/`：
  - `tokens.css`：变量、基础排版、按钮、输入框、卡片、toast。
  - `ui.js`：`h(tag, attrs, ...children)` 建 DOM、`toast(msg, isError)`、`fmtCountdown(ms)`、`isWeChat()`。
  - `api.js`：`api(path, {method, body})`，自动处理 JSON 与错误，失败时抛出 `Error(error 字段)`。
- **资料库页面**：
  - `/library/` 目录页：产品卡片显示价格、卖点、文档数、「试读」「查看详情」；页面顶部是解锁区，可以输入密钥，或用学员账号登录。会话有效时，卡片显示「已解锁」和倒计时。
  - `/library/item.html?p=<id>`：售卖页正文、目录、试读入口；解锁后显示「在线阅读」，key 会话另有「下载 PDF」。
  - `/library/read.html?p=<id>&d=<docId>` 阅读器：左侧文档目录（手机端收成抽屉），正文区铺满平铺水印（`watermark.line1/line2`）。key 会话顶部显示倒计时横幅，过期后自动锁定并提示。学员会话禁用右键、选中复制和打印（打印样式隐藏正文），不显示下载按钮。
  - 在微信里点下载时，提示「请点右上角在浏览器中打开后下载」。
  - 必须在页面上如实说明：只读保护只能防止随手转发，挡不住截图。
- **管理后台** `/admin/`：
  - 登录。
  - **快速发码**：每个产品一个按钮，默认 30 分钟、3 次使用；可勾选多个产品合发一个码；可填买家备注（输入框下注明「仅自己可见」：备注只在后台显示，不会返回给买家，也不进水印）。生成后大字显示密钥和倒计时，并提供「复制密钥」「复制发送话术」（话术包括站点链接、密钥、有效期、使用说明）。
  - 有效密钥列表，可撤销。
  - 学员账号：创建（到期日默认填当年 10 月 31 日）、重置密码、停用/启用、删除。明文密码只显示一次，并提供「复制账号信息」。

## 7. 学员信息采集重写要求（src/intake）

- **功能完全对齐原版**：
  - 6 步表单（schema 见 `reference/legacy_app_core.min.js` 中的 `O6` / `On` 与字段构造函数 `g6/$3/R7/d5/s0/X3`）。
  - 可重复的经历条目、「待确认」标记（`G0` 常量）、「不适用」「未考」、校验规则、完成度、localStorage 自动保存，**存储键和数据结构与原版相同**，保证老学员的草稿能继续读。
  - JSON 导入导出（含原版的完整校验）、清除草稿、微信环境提示。
  - 原版界面参见 `reference/legacy_app_ui.min.js` 与 `legacy/app.css`。
- **导出 Word**（docx@9，按需动态加载）：
  - A4，页边距约 2cm，中文字体用「微软雅黑」，eastAsia 字体同样设置。
  - 页眉：「保研全程陪跑 · 学员档案」，右对齐、灰色小字。页脚：「第 X 页 / 共 Y 页」，居中。
  - 文档开头：标题，再接一张信息卡表格（称呼、学校、学院、专业、年级、填表日期、最后更新）。
  - 「档案概览」框：完成度、待确认项数、需修正项数，以及关键指标：GPA x/满分、学业排名 a/b、CET-4/6、科研项目数、论文数、目标院校。
  - 每个模块：标题（藏青色加左侧色条或底纹），下面是一行灰色说明，再接两列表格。左列为标签，约占 28%，浅底 `#F2F5FA`；右列为值。边框用 `#E4E9F1`。值为「未填写」时用灰色斜体；值含「待确认」时用琥珀色底纹 `#FFF4DB`。
  - 多行文本保留换行。可重复的条目各自加一行标题，横跨两列、浅蓝底，写成「科研项目 1 · <名称>」。模块为空时写一句说明。
  - 文件名规则与原版 `Rn()` 相同。
- **导出 PDF**：
  - 生成一个打印用报告页面（可以是应用内的全屏预览层，也可以是 `report.html`），版式与 Word 一致。
  - 用 `window.print()` 另存为 PDF。打印 CSS 要设置 `@page { size:A4; margin:… }`，并用 page margin boxes 显示页码（Chrome 131 及以上支持；不支持的浏览器不显示页码，不影响导出）。
  - 微信内提示到浏览器中打开。**去掉 14MB 内嵌字体和 pdf-lib 导出。**
- 采集页的 JS 首屏体积不超过 300KB（gzip 前），docx 按需加载。

## 8. 验收（e2e）

- 实际的测试文件（`export PATH=…` 后在项目根运行）：
  - `node --test tests/worker.unit.test.mjs tests/frontend.test.mjs tests/content.test.mjs tests/intake-core.test.mjs`：Worker 工具函数、PDF 授权标识、KV 旧缓存下的撤销/停用/重置（模拟节点读到旧值）、发布前检查等。
  - `node tests/worker.e2e.mjs`：用 fetch 测 Worker API。8787 端口没有服务时，它会用 `scripts/dev-seed.mjs` 的假数据建一个独立 KV 并自己启动 `wrangler dev`（约 80 秒，因为要等 1 分钟密钥过期）。
  - `node tests/frontend-e2e.mjs`：puppeteer-core 驱动本机 Chrome，测试对象是 `tests/mock-api.mjs`（按本文件 §4 模拟接口），前端要先用 `node scripts/build-site.mjs --only site,library,login,admin --out test-artifacts/frontend-dist` 打包。截图存到 `test-artifacts/screens/frontend-*.png`。
- 覆盖的用例：
  - 管理员登录。
  - 发出一个 P2 密钥，在新的浏览器上下文里兑换。
  - 阅读 P2 文档，能下载 PDF；访问 P5 返回 403。
  - 撤销密钥后访问返回 401/403。
  - 发出一个 minutes=1 的密钥，等待 70 秒后访问被锁定。
  - 创建学员并登录，可阅读 KIT 和 P4，下载返回 403。
  - 停用学员后访问返回 403。
  - 采集页能导出 Word（文件可被 docx 解析，或 Word 能打开），打印预览页能渲染。
- 每个页面在桌面（1366×900）和手机（390×844）各截一张图，存到 `test-artifacts/screens/`。
