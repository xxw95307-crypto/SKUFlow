# SKUFlow AI

> 把供应商发来的一堆图片、表格和 PDF，变成可以直接审核上架的多平台 Listing。

跨境卖家上新一款商品，往往要从零散的供应商资料里手工摘参数，再按 Amazon、Shopify、TikTok Shop、Shopee 各自的字段规则重写一遍，最后还要配图、做视频、翻译成目标站点语言。SKUFlow 用一个对话式 Agent 把这条链路串起来：**AI 负责整理和撰写，商家只在关键节点做决定。**

## 它是怎么工作的

```text
 上传资料                理解商品                    生成与审核                  交付
┌──────────┐      ┌──────────────────┐      ┌────────────────────┐      ┌──────────────┐
│ 图片      │      │ 文件解析          │      │ 按平台 Schema 生成  │      │ 目标语言本地化 │
│ XLSX/CSV │ ───▶ │ 视觉理解（OCR）   │ ───▶ │ 中文 Listing 审校稿 │ ───▶ │ 平台草稿交付   │
│ PDF/TXT  │      │ 事实抽取 + 冲突检测│      │ 商品图 / 商品视频   │      │              │
└──────────┘      └──────────────────┘      └────────────────────┘      └──────────────┘
                          │                          │                         │
                    ▼ 图文冲突确认            ▼ 逐平台审核 / 选素材        ▼ 发布前最终确认
                                  （商家只在这几处介入）
```

1. **上传即开始**：一个任务对应一款商品，不需要预填商品名，模型会综合图片和文档自动命名。
2. **Product Passport（商品事实档案）**：每条属性都带证据，可定位到具体文件页码、表格范围、文本行号或图片区域。
3. **冲突不替你拍板**：图片说 380 ml、规格表写 500 ml？系统把两个候选值都摆出来，由商家选择或手动核实。
4. **一份事实，多平台编译**：按“平台 × 站点 × 类目”取 Listing Schema，事实字段直接映射，标题、卖点、描述由 Agent 撰写，AI 推断字段必须商家勾选确认后才能批准。
5. **视觉素材**：根据商品事实规划场景，生成商品图和图生视频（含背景音/配音），再由 Agent 编排封面与媒体顺序。
6. **交付**：审核通过的稿件翻译成目标站点语言后交付。全程由显式状态机把关，无法跳过事实确认和人工审核直接发布。

支持**单商品对话**和**批量上新**两种入口：批量模式下，一个总文件夹里的每个子文件夹就是一款商品，逐款分析，异常商品不阻塞其他商品，详见 [docs/batch-publishing.md](docs/batch-publishing.md)。

## 平台接入现状

| 平台 | Listing 生成 | 交付方式 |
| --- | --- | --- |
| Shopify | 专用 Schema + 校验 | **真实开发店铺**中创建未公开草稿，同步图片与视频 |
| Amazon | 专用 Schema，覆盖官方 23 个站点 | 调用 SP-API **官方静态沙箱**做 `VALIDATION_PREVIEW`，不代表正式上架 |
| TikTok Shop / Shopee | 专用 Mock Schema | 本地 Mock 草稿 |
| eBay、Walmart、Etsy、Lazada 等 8 个 | 通用 Schema | 已登记，待接入 |

所有平台都不会自动公开商品，也不会把沙箱或 Mock 响应当作真实上架结果。各平台边界见 [docs/amazon-us-integration.md](docs/amazon-us-integration.md) 和 [docs/mock-platform-flow.md](docs/mock-platform-flow.md)。

## 技术栈

- **前端 / 服务端**：Next.js 16 App Router（通过 [vinext](https://www.npmjs.com/package/vinext) 运行在 Vite + Cloudflare Workers 上）、React 19、Tailwind CSS 4
- **存储**：Cloudflare D1（任务、事实、证据、审计记录）+ R2（源文件、生成的图片和视频）
- **模型**：阿里云百炼
  - `qwen3.8-max`：视觉理解、事实抽取、Listing 撰写与本地化
  - `qwen-image-2.0`：商品图生成
  - `wan2.7-i2v`：图生视频；`qwen-audio-3.1-tts-next`：音效与背景音乐
- **解析**：`unpdf`（PDF）、`xlsx`（表格）
- **登录**：账号密码、阿里云短信验证码、微信扫码；所有 API 按账号校验数据归属

## 快速开始

需要 Node.js ≥ 22.13 和 pnpm。

```bash
pnpm install
cp .env.example .env.local   # 至少填写 BAILIAN_API_KEY
pnpm dev
```

打开 <http://localhost:3000>。D1 和 R2 在本地由 Miniflare 模拟，数据保存在 `.wrangler/` 下，无需单独建库；表结构会在首次请求时自动创建。健康检查：`GET /api/health`。

### 环境变量

完整列表见 [.env.example](.env.example)。只填百炼 Key 就能跑通从上传到 Mock 交付的主流程，其余按需配置：

| 变量 | 用途 | 是否必需 |
| --- | --- | --- |
| `BAILIAN_API_KEY` / `BAILIAN_BASE_URL` / `BAILIAN_MODEL` | 文本与视觉模型 | 必需 |
| `BAILIAN_IMAGE_MODEL` | 商品图生成 | 生成图片时 |
| `BAILIAN_VIDEO_API_KEY` | 视频生成，默认复用 `BAILIAN_API_KEY` | 可选 |
| `SHOPIFY_DEV_*` | Shopify 开发店铺草稿交付 | 可选 |
| `AMAZON_SP_API_SANDBOX_*` | Amazon 官方沙箱 | 可选 |
| `ALIYUN_PNVS_*` | 短信验证码登录 | 可选 |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 微信扫码登录 | 可选 |

所有密钥只在服务端读取，不会进入浏览器、源码或数据库。只提交 `.env.example`，不要提交 `.env.local`。

## 常用命令

```bash
pnpm dev                    # 本地开发
pnpm build                  # 生产构建
pnpm lint                   # ESLint
pnpm test:day5              # 运行 tests/ 下全部单元测试
pnpm test:amazon-sandbox    # 用 .env.local 中的凭据测试 Amazon 沙箱连通性
```

> `test:day2` 到 `test:day5`、`test:vision` 目前都运行同一组全量测试，保留是为了兼容开发阶段的验收脚本。

## 目录结构

```text
app/
  page.tsx               对话式 Agent 工作区（默认入口）
  batches/               批量上新
  login/                 登录页
  api/                   API 路由：tasks、batches、conversations、platforms、auth、integrations
components/              界面组件：对话、审核层、Passport 面板、媒体编排、发布确认等
lib/
  agents/                各 Agent 的 Prompt 与输出规范化（视觉、事实、Listing、本地化、场景、素材、视频）
  ai/                    百炼客户端与万相视频接口
  domain/                核心领域模型：Task、ProductPassport、Listing、Conversation 等
  parsers/               图片、PDF、表格、文本统一解析为带定位的内容块
  platform-sdk/          PlatformAdapter 接口、规则配置与按优先级解析的适配器注册表
  platforms/             平台注册表、Amazon SP-API、Shopify Admin API
  mock-platforms/        Mock Listing Schema、校验与编译
  server/                D1/R2 读写、鉴权、视频任务
  workflow/              任务状态机
db/                      D1 Schema 与迁移
tests/                   单元测试（node:test）
docs/                    设计与接入文档
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [batch-publishing.md](docs/batch-publishing.md) | 批量上新的文件夹结构、限制与交付规则 |
| [mock-platform-flow.md](docs/mock-platform-flow.md) | 对话主流程、Mock Schema 与接口 |
| [vision-agent.md](docs/vision-agent.md) | 图片视觉理解 Agent |
| [video-generation.md](docs/video-generation.md) | 图生视频、音频生成与 Shopify 媒体编排 |
| [amazon-us-integration.md](docs/amazon-us-integration.md) | Amazon 沙箱接入与真实上架的后续步骤 |
| [platform-access-matrix.md](docs/platform-access-matrix.md) | 各平台开发者权限状态 |
| `day-0X-acceptance.md` | 开发阶段的逐日验收记录 |
