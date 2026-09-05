# SKUFlow AI

SKUFlow 将供应商图片、表格、PDF 和文本资料整理为可追溯的商品事实档案，并通过平台适配器编译为不同电商平台的上架草稿。

默认界面是对话式 Agent 工作区：上传后由 Agent 自动串联资料解析、商品理解和 Listing 生成；只在图文冲突、平台稿审核、视觉素材选择和最终发布节点弹出结构化卡片请商家决策。

## 当前已完成

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
- 图片视觉理解 Agent：从私有 R2 读取原图，通过同一个 `qwen3.8-max` 抽取 OCR、可见商品属性和归一化图片区域。
- Agent 间证据交接：视觉结果作为 `VISION` 证据进入事实 Agent，纯图片任务可以继续生成 Product Passport。
- 视觉运行审计：每张图片独立记录模型、Prompt 版本、输入哈希、结构化结果、Token 与错误。
- 单商品任务：一个任务中的全部图片、PDF、表格和文本默认属于同一个商品，无需额外做商品聚类。
- 一键商品理解：上传后自动完成文件读取、图片属性提取、多源事实合并和冲突检查。
- 自动商品命名：创建任务时不要求商家预填名称；模型综合图片外观、包装文字和文档资料生成统一商品名称并写回任务。
- 跨模态冲突：图片事实与文档事实使用统一字段名比较；不同值保留为候选项，不由模型擅自裁决。
- 冲突确认闭环：商家可采用图片值、采用文档值或手动填写核实值，选择结果会写回档案并保留审计记录。
- 属性归一化：常见单位表达会归一后比较，例如 `0.38 L` 与 `380 ml` 不会被误判为冲突。
- 稳定属性过滤：价格、折扣、销量、店铺信息和页面按钮不会进入 Product Passport。
- Mock 平台服务器：12 个已登记平台均可按“平台 + 站点 + 类目”返回 Listing Schema；每份 Schema 都包含模型生成的统一商品名称字段，Amazon、TikTok Shop、Shopify、Shopee 使用专用字段，其余平台使用通用 Schema。
- 开放式 Product Passport：模型尽量完整提取资料中实际出现的稳定属性，不再预塞与商品类目无关的通用空字段；每项属性保留证据与图文冲突。
- 多平台 Listing Agent：同一次任务以平台为单位生成中文审校稿，资料字段直接映射，营销内容及平台缺失字段由百炼用中文补写；目标市场语言作为发布元数据保留，后续在发布阶段本地化。无法可靠判断的客观字段使用中性候选值并等待核对，SKU、价格和库存留给卖家填写。
- 动态审核工作台：页面按 Mock Schema 渲染字段、显示“资料提取 / 智能体创作 / AI 推断 / 卖家填写”来源，AI 推断值经卖家勾选确认后才能批准。
- Mock 发布交付：确认后的版本可创建模拟平台草稿并返回 Mock draft ID；不会连接或修改真实卖家店铺。
- 对话式编排：用户不需要手动在五个页面之间推进；Agent 自动调用现有工具，并在决策点使用冲突卡、Listing 审核层、选图卡和发布确认层。
- 渐进式详情：对话默认展示结论和待办，商品事实、证据、字段来源和校验信息收起在右侧详情和弹出审核层中。

Product Passport、文件解析、视觉理解、事实抽取、Listing 生成、人工审核和 Mock 草稿交付均使用持久化任务数据；视觉理解、事实抽取和 Listing 生成共用一套百炼模型配置。视觉素材生成页当前仍为明确标注的 Mock 工作流，下一阶段再接图片生成模型。

完整的 Mock 接口和替换真实平台 API 的边界见 [`docs/mock-platform-flow.md`](docs/mock-platform-flow.md)。

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
pnpm test:vision
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
lib/agents/vision-analysis.ts  视觉 Prompt 与输出规范化
lib/platform-sdk/        通用接口、规则编译器与适配器注册表
lib/mock-platforms/      Mock Listing Schema、校验与编译逻辑
tests/                   Day 1–5 验收测试
```

## 密钥安全

真实平台密钥只保存在本地环境或托管平台的加密变量中。仓库仅提交 `.env.example`，不得提交 App Secret、Access Token、Refresh Token 或卖家凭据。
