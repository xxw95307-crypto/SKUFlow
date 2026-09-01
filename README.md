# SKUFlow AI

SKUFlow 将供应商图片、表格、PDF 和文本资料整理为可追溯的商品事实档案，并通过平台适配器编译为不同电商平台的上架草稿。

## Day 1 已完成

- 真实文件上传：源文件进入 R2 对象存储。
- 持久化任务：任务、文件元数据和状态事件进入 D1。
- 显式状态机：禁止绕过事实确认和人工审核直接发布。
- 平台注册表：首批登记 12 个平台，默认参考适配器为 Amazon、TikTok Shop、Shopify 和 Shopee。
- 核心领域模型：`Task`、`ProductPassport`、`PlatformProfile`。
- 最小 API：健康检查、任务创建、任务详情、状态推进。
- 可运行界面：用户可选择市场和平台、上传真实文件、创建任务并启动资料解析状态。

后续页面中的商品事实、Listing 和素材仍是预置演示内容，Day 2–4 将逐步替换为真实解析结果。

## 本地运行

```bash
pnpm dev
```

应用入口为 `http://localhost:3000`，健康检查为 `GET /api/health`。

## 验证

```bash
pnpm test:day1
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
tests/                   Day 1 验收测试
```

## 密钥安全

真实平台密钥只保存在本地环境或托管平台的加密变量中。仓库仅提交 `.env.example`，不得提交 App Secret、Access Token、Refresh Token 或卖家凭据。
