# SKUFlow AI

SKUFlow 将供应商图片、表格、PDF 和文本资料整理为可追溯的商品事实档案，并通过平台适配器编译为不同电商平台的上架草稿。

## Day 1–5 已完成

- 真实文件上传：源文件进入 R2 对象存储。
- 持久化任务：任务、文件元数据和状态事件进入 D1。
- 显式状态机：禁止绕过事实确认和人工审核直接发布。
- 平台注册表：首批登记 12 个平台，默认参考适配器为 Amazon、TikTok Shop、Shopify 和 Shopee。
- 核心领域模型：`Task`、`ProductPassport`、`PlatformProfile`。
- 最小 API：健康检查、任务创建、任务详情、状态推进。
- 可运行界面：用户可选择市场和平台、上传真实文件、创建任务并启动资料解析状态。
- Product Passport：带版本号的商品事实、SKU 变体、证据定位与事实—证据关联。
- 冲突账本：候选值、证据引用、裁决结果和冲突状态均有独立结构。
- 平台草稿矩阵：按“平台 × 市场”初始化草稿，并预留 Schema、类目、校验与发布状态。
- 可编辑事实：品牌与候选类目可通过 API 保存；每次修改生成表单证据并递增护照版本。
- 状态机元数据：明确每一阶段由用户、Agent 或系统负责，并标注人工关口与终态。
- 多格式解析：图片、PDF、XLSX/XLS、CSV 和文本进入统一解析入口。
- 统一解析结果：文本、表格和图片统一为带定位的内容块，并记录哈希、警告与错误。
- 解析结果持久化：D1 保存解析结构，R2 保留源文件，支持刷新恢复与强制重新解析。
- 解析工作台：可查看逐文件结果摘要并下载 `UnifiedParseResult v1.0` JSON。
- 百炼事实 Agent：通过 OpenAI 兼容接口调用 `qwen3.8-max`，从解析文本中抽取商品事实。
- 可审计证据链：每个模型事实必须引用具体文件页码、工作表范围或文本行号，并记录置信度。
- 冲突与缺失检测：同一字段的多个候选值进入冲突账本，16 个核心字段无证据时明确标记为缺失。
- Agent 运行记录：持久化模型、Prompt 版本、输入哈希、运行状态、结构化输出与 Token 用量。
- 密钥隔离：百炼 API Key 只从服务端运行时加密变量读取，不进入浏览器、源码或数据库。
- Platform Adapter SDK：统一 `PlatformAdapter` 编译接口、版本化规则配置和按优先级解析的 Adapter Registry。
- 通用草稿编译：Product Passport 可真实编译并持久化为每个“平台 × 市场”的 Payload、Schema 版本和校验结果。
- 多平台兜底：通用 Adapter 覆盖注册表中的 12 个平台，后续平台专用 Adapter 可按优先级无侵入替换。
- SDK 编译台：可查看接口版本、字段规则、平台注册覆盖、编译摘要与实际 JSON 草稿。

Product Passport、文件解析、文本事实抽取和通用草稿编译均已使用真实持久化数据；Listing 和素材页面仍是预置演示内容。当前 Token Plan 接口仅用于文本推理，图片块会保留为待多模态处理。Day 6 将接入首批平台的专用字段结构。

## 本地运行

```bash
pnpm dev
```

应用入口为 `http://localhost:3000`，健康检查为 `GET /api/health`。

## 验证

```bash
pnpm test:day1
pnpm test:day2
pnpm test:day3
pnpm test:day4
pnpm test:day5
pnpm lint
pnpm build
```

## 目录

```text
app/api/                 API 路由
components/              产品界面组件
data/                    演示商品数据
db/                      D1 Schema 与迁移
lib/domain/              核心领域模型
lib/platforms/           多平台注册表
lib/workflow/            Agent 任务状态机
lib/parsers/             图片、PDF、表格与文本解析器
lib/agents/              事实抽取 Prompt、上下文与输出规范化
lib/ai/                  百炼 OpenAI 兼容客户端
lib/platform-sdk/        通用接口、规则编译器与适配器注册表
tests/                   Day 1–5 验收测试
```

## 密钥安全

真实平台密钥只保存在本地环境或托管平台的加密变量中。仓库仅提交 `.env.example`，不得提交 App Secret、Access Token、Refresh Token 或卖家凭据。
