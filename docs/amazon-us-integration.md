# Amazon 多站点适配边界

## 当前目标：按所选站点测试亚马逊官方静态沙箱

不用注册自己的专业卖家店铺，也不用找真实卖家授权，就可以先走官方沙箱。按[亚马逊开发者接入流程](https://developer-docs.amazon.com/sp-api/docs/onboarding-overview)：创建 Solution Provider Portal 账号，填写开发者资料，再创建 **Application type = Sandbox** 的 SP-API 应用。官方说明在开发者资料审核期间即可开始测试。应用后台的 **View sandbox credentials** 可取得沙箱 client ID / client secret，**Create Token** 可生成沙箱 refresh token；这个令牌并非真实卖家的授权令牌。[官方操作步骤](https://developer-docs.amazon.com/sp-api/docs/onboarding-step-5-make-your-first-call-to-the-sp-api-sandbox)

把三项值仅写入本地 `.env.local`（不要放进浏览器、对话或 Git）：

```dotenv
AMAZON_SP_API_SANDBOX_CLIENT_ID=
AMAZON_SP_API_SANDBOX_CLIENT_SECRET=
AMAZON_SP_API_SANDBOX_REFRESH_TOKEN=
```

运行 `npm run test:amazon-sandbox` 会用美国站示例测试北美沙箱连通性。网站中的测试入口则按用户选择的站点，选择官方 marketplace ID 与北美、欧洲或远东沙箱地址。终端和网页都不输出令牌，也不向正式 SP-API 域名提交商品。

Amazon 演示审核稿中有一个 **“单独测试此站点沙箱连通性”** 按钮，调用受登录保护的 `/api/integrations/amazon-sandbox`，显示该站点所在区域的预设示例响应。网页按钮使用**网站服务器运行环境**中的沙箱配置；本地 `.env.local` 不会自动同步到已发布的网站。这个按钮不发送当前 Listing 的字段，也不改变审核状态。

**能力边界：**亚马逊的 Product Type Definitions 与 Listings Items 在托管沙箱中只支持**静态**响应，按请求参数匹配预置示例；`LUGGAGE` 示例中的 Schema 链接是占位值，不能据此取得所选站点 T 恤的真实字段，也不能证明真实 Listing 会通过校验。当前应用审核稿仍标为 `MOCK`，不会因为沙箱请求成功就自动标记为官方规则或已上架。[亚马逊沙箱说明](https://developer-docs.amazon.com/sp-api/docs/sp-api-sandbox)

当前 Amazon Listing 是 SKUFlow 的演示审核稿，`mode=MOCK`。这些示例字段没有经过 Amazon 官方商品类型定义校验，也不会写入卖家店铺。`lib/platforms/amazon-markets.ts` 列出了官方 23 个站点的 marketplace ID、区域、默认语言与币种；未知站点会在调用前明确报错，不会悄悄退回本地 Mock。站点 ID 和所属区域分别参照[官方 Marketplace IDs](https://developer-docs.amazon.com/sp-api/docs/marketplace-ids)与[官方 SP-API Endpoints](https://developer-docs.amazon.com/sp-api/docs/sp-api-endpoints)。

## SKUFlow 现有沙箱交付链路

选择任一已列出的 Amazon 站点后，SKUFlow 提取商品事实、生成中文审核稿，并提出商品类型代码候选值。卖家需核对商品类型、品牌、SKU、所选站点币种的价格、库存和五点描述，逐项确认 Listing。视觉素材生成后，卖家选择图片/视频并确认媒体顺序。最终人工确认界面展示目标站点语言的译文与测试模式说明。

确认后，服务端把已审核且已本地化的标题、品牌、五点描述、商品描述、售价、库存等映射为 `putListingsItem` 结构，以 `mode=VALIDATION_PREVIEW` 发送给所选站点对应的 **`sandbox.sellingpartnerapi-na/eu/fe.amazon.com`**。本地保存请求摘要、媒体顺序与官方静态沙箱响应，页面标记“沙箱测试已完成”。图片/视频因目前没有面向 Amazon 的公开媒体地址而仅保留在 SKUFlow，**不随请求上传到 Amazon**。静态沙箱可能返回 `ACCEPTED` 和与请求不同的预置 SKU；这些都不是当前商品通过规则校验、创建草稿或上架成功的证据。

## 已完成的接入基础

`lib/platforms/amazon-us-product-types.ts` 提供服务端商品类型定义读取器。获得卖家授权、Product Listing 权限和 LWA access token 后，可按商品类型、卖家及变体层级调用 `getDefinitionsProductType`，再下载短期有效的 JSON Schema 文档。读取失败时必须保持 Mock 状态，不得把演示字段当作官方要求。

`lib/platforms/amazon-us-listings.ts` 已封装 LWA refresh token 换取访问令牌、`putListingsItem` 的 `VALIDATION_PREVIEW` 与正式提交，以及 `getListingsItem` 回读。正式提交和回读仍未连接到发布按钮。

发布交付页新增了独立的 **“读取官方字段并预校验”** 入口。卖家授权齐备后，服务端根据已确认的商品类型和所选站点向正式环境读取卖家专属 Product Type Definitions，下载短期有效的 Schema，列出当前映射中缺少的顶层必填属性和未被官方 Schema 支持的属性，再使用 `mode=VALIDATION_PREVIEW` 检查已确认、已本地化的 Listing。预校验结果只在当前页面展示，不会创建商品，也不会把 Mock 审核稿改标为正式通过。顶层必填字段检查不能覆盖条件规则和嵌套约束；以正式接口返回的问题为准。未接入的官方字段仍需要后续按 Schema 动态填写与映射，不能把这条预校验链路当成完整的真实上架闭环。

## 后续真实闭环

1. 确定目标商品类型及单品、父变体或子变体层级。对当前 T 恤样品，可先核实 `SHIRT` 类型，不能只按“服装”中文标签猜测。
2. 使用授权卖家对应的 Product Type Definitions Schema 生成审核字段和条件校验。保留 Schema 版本/校验和，若规则变化则重新审核。
3. 将已核实的事实与卖家经营字段映射成 Listings Items 格式；运行本地 Schema 校验并调用 `mode=VALIDATION_PREVIEW`。预校验通过后，仍须等待卖家确认才实际提交。
4. 真正提交后读取商品状态与 issues；`ACCEPTED` 仅代表初步受理，不能当作已上架成功。

没有专业卖家账户时可以开发和测试本地映射器与页面，但不能完成卖家授权、读取卖家专属规则或验证真实店铺写入。私有卖家应用要求专业销售账户；面向其他卖家的公共应用须另行完成开发者注册和 OAuth 授权流程。

## 自有卖家账户的接通步骤

1. 完成美国站专业卖家账户注册，并用主账号在 Seller Central 的 **Apps and Services → Develop Apps** 申请私有 SP-API 开发者身份。
2. 在开发者资料和应用中申请 **Product Listing** 角色，按 Amazon 审核要求提交真实用途和安全控制信息。
3. 创建私有应用并自授权，取得 LWA client ID、client secret、refresh token，以及 seller ID。将这些值分别保存在服务端加密环境变量 `AMAZON_SP_API_CLIENT_ID`、`AMAZON_SP_API_CLIENT_SECRET`、`AMAZON_SP_API_REFRESH_TOKEN`、`AMAZON_SELLER_ID`，不可写入前端、源码或对话。旧的 `AMAZON_US_SELLER_ID` 仍可兼容使用。
4. 接通后先读取目标商品类型 Schema，再完成真实字段映射和 `VALIDATION_PREVIEW`；经卖家确认后才提交，并通过 `getListingsItem` 回读状态与问题。

目前本地与已发布网站都只有沙箱凭据，没有第 1–3 步所需的正式卖家授权。第 4 步中的正式字段读取与不落库预校验入口已接入交付页，但在授权前不能真实调用；平台审核界面仍为 Mock，不能触发真实提交。

资料来源：[SP-API 注册](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/sp-api-registration-overview)、[Product Type Definitions](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/retrieve-a-product-type-definition)、[Listing 生命周期](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)。
