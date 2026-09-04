# Mock 平台 Listing 链路

当前实现的目标是先验证完整业务闭环，不依赖真实卖家账号，也不会向任何真实平台写入商品。

## 运行顺序

1. 商家为同一个商品选择多个平台和站点，批量上传图片、PDF、表格和文本。
2. 图片理解、文档解析与事实 Agent 合并出一份 `ProductPassport`；图文冲突必须先由商家确认。
3. 系统根据每个“平台 × 站点 × 类目”取得 Mock Listing Schema。
4. 客观字段只从无冲突的商品事实映射；标题、卖点、描述和搜索词交给 Listing Agent 生成；SKU、售价和库存留给卖家填写。
5. 前端按照各平台 Schema 动态展示字段，卖家修改后执行类型、长度、条数和必填校验，并逐个平台确认。
6. 视觉素材阶段完成选择后，确认过的 Listing 可发送到 Mock 发布接口，生成 `mock_*` 草稿编号。

## Mock API

- `GET /api/platforms/:platformId/listing-schema?market=美国&categoryLabel=便携榨汁杯`：返回平台字段定义。
- `POST /api/platforms/:platformId/listings`：用 `validate` 校验 Listing，或用 `create_draft` 模拟创建草稿。
- `POST /api/tasks/:taskId/compile-drafts`：为任务中的全部平台/站点取得 Schema，并调用百炼生成营销字段。
- `PATCH /api/tasks/:taskId/listing-drafts`：保存或确认卖家修改后的平台 Listing。
- `POST /api/tasks/:taskId/publish-mock`：为已确认版本创建 Mock 草稿。

## 切换真实平台时保留的边界

前端继续依赖统一的字段定义、草稿状态和校验结果。后端将 Mock Schema 获取、校验、草稿创建分别替换为平台 Adapter，并在 Adapter 内处理 OAuth、类目映射、限流、错误码和真实字段转换。商品事实、Listing Agent、审核页面和交付状态不需要重写。
