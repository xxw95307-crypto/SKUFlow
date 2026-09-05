# Mock 平台 Listing 链路

## 对话式主流程

前端以 Agent 对话为主轴，不再要求用户逐页操作。上传完成后，Agent 自动执行资料解析、视觉理解、事实合并与平台 Listing 生成。仅在以下检查点暂停：

1. 图片与文档事实冲突：弹出候选值卡片，由商家选择或手动核实。
2. 平台 Listing 审核：按平台展示中文审校稿，并集中补充必须由卖家提供的经营字段。
3. 视觉素材选择：弹出候选素材卡。当前为 Mock，后续替换为真实图像生成工具。
4. 最终发布：展示平台、市场、Listing 和素材范围，获得明确确认后才调用发布工具。

当前实现的目标是先验证完整业务闭环，不依赖真实卖家账号，也不会向任何真实平台写入商品。

## 运行顺序

1. 商家为同一个商品选择多个平台和站点，直接批量上传图片、PDF、表格和文本，无需预填商品名称。
2. 图片理解、文档解析与事实 Agent 综合证据自动生成商品名称，并合并出一份 `ProductPassport`；图文冲突必须先由商家确认。
3. 系统先形成开放式 Product Passport：资料中出现多少个可信稳定属性，就尽量抽取多少个，不预设全类目通用必填属性。
4. 系统根据每个“平台 × 站点 × 类目”取得 Mock Listing Schema；商品名称也由 Schema 明确返回。
5. 无冲突的商品事实直接映射；平台标题、卖点、描述和搜索词交给 Listing Agent 创作；平台缺失字段由 Agent 给出候选值并标记为 `AI_INFERRED`。确实无法判断时使用中性候选值，不伪造认证或具体数值；SKU、售价和库存仍由卖家填写。
6. Listing Agent 以平台为单位生成简体中文审校稿；Schema 中的目标 locale 仅用于后续发布本地化。
7. 卖家需核对并勾选确认所有 `AI_INFERRED` 字段，之后才能批准平台 Listing。
8. 前端按照各平台 Schema 动态展示字段，卖家修改后执行类型、长度、条数和必填校验，并逐个平台确认。
9. 视觉素材阶段完成选择后，确认过的 Listing 可发送到 Mock 发布接口，生成 `mock_*` 草稿编号。

## Mock API

- `GET /api/platforms/:platformId/listing-schema?market=美国&categoryLabel=便携榨汁杯`：返回平台字段定义。
- `POST /api/platforms/:platformId/listings`：用 `validate` 校验 Listing，或用 `create_draft` 模拟创建草稿。
- `POST /api/tasks/:taskId/compile-drafts`：为任务中的全部平台/站点取得 Schema，并调用百炼生成营销字段。
- `PATCH /api/tasks/:taskId/listing-drafts`：保存或确认卖家修改后的平台 Listing。
- `POST /api/tasks/:taskId/publish-mock`：为已确认版本创建 Mock 草稿。

## 切换真实平台时保留的边界

前端继续依赖统一的字段定义、草稿状态和校验结果。后端将 Mock Schema 获取、校验、草稿创建分别替换为平台 Adapter，并在 Adapter 内处理 OAuth、类目映射、限流、错误码和真实字段转换。商品事实、Listing Agent、审核页面和交付状态不需要重写。
