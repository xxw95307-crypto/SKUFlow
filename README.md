# SKUFlow AI

SKUFlow 将供应商图片、表格、PDF 和文本资料整理为可追溯的商品事实档案，并通过平台适配器编译为不同电商平台的上架草稿。

## Day 1–2 已完成

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

Product Passport 页面已使用真实持久化数据；Listing 和素材页面仍是预置演示内容。Day 3 将接入图片、PDF、Excel 与文本解析。

## 本地运行

```bash
pnpm dev
```

应用入口为 `http://localhost:3000`，健康检查为 `GET /api/health`。

## 验证

```bash
pnpm test:day1
pnpm test:day2
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
tests/                   Day 1–2 验收测试
```

## 密钥安全

真实平台密钥只保存在本地环境或托管平台的加密变量中。仓库仅提交 `.env.example`，不得提交 App Secret、Access Token、Refresh Token 或卖家凭据。
