# Day 5 验收：Platform Adapter SDK

## 今日交付

Day 5 已完成可扩展的平台适配底座，目标不是提前实现某一家平台的全部官方字段，而是让后续平台接入遵循同一套接口：

1. 通用 `PlatformAdapter` 接口：声明适配器身份、版本、优先级、支持平台、规则集与 `compile()` 方法。
2. 版本化规则配置：`PlatformRuleConfig v1.0` 描述护照事实到目标字段的映射、转换和校验。
3. Adapter Registry：注册、重复检测、平台发现和优先级解析；平台专用 Adapter 可覆盖通用兜底 Adapter。
4. 通用编译 API：把任务的 Product Passport 编译并持久化到每个“平台 × 市场”草稿。
5. SDK 编译台：展示注册数量、12 平台覆盖、规则映射、编译摘要和实际 JSON Payload。

## 通用接口

核心契约位于 `lib/platform-sdk/types.ts`：

```ts
interface PlatformAdapter {
  id: string;
  version: string;
  priority: number;
  kind: 'fallback' | 'platform';
  supports: readonly PlatformId[];
  rules: PlatformRuleConfig;
  compile(context: PlatformAdapterContext): AdapterCompileResult | Promise<AdapterCompileResult>;
}
```

调用方只依赖该接口，不直接依赖 Amazon、TikTok Shop 等平台实现。

## 规则配置格式

`PlatformRuleConfig v1.0` 是纯数据结构，可放进 TypeScript、JSON 或未来的数据库配置中：

```json
{
  "schemaVersion": "1.0",
  "id": "core-product",
  "version": "1.0.0",
  "fields": [
    {
      "sourceFact": "product.name",
      "targetPath": "product.title",
      "transforms": [{ "type": "trim" }],
      "validations": [
        { "type": "required" },
        { "type": "maxLength", "value": 200 }
      ]
    }
  ]
}
```

加载时会拒绝非法路径、危险原型字段、重复目标字段和无效长度限制。当前内置 8 个通用映射规则。

## 注册与发现

当前 `core-product-adapter` 的优先级为 `0`，作为 12 个登记平台的兜底实现。Day 6 增加平台实现时，只需注册优先级更高的 Adapter：

```ts
registry
  .register(coreProductAdapter)
  .register(amazonAdapter); // priority: 100

registry.resolve('amazon'); // amazonAdapter
registry.resolve('etsy');   // coreProductAdapter
```

因此系统的平台能力不被 Amazon、TikTok Shop、Shopify、Shopee 四个平台写死。

## API 与持久化

- `GET /api/platform-adapters`：返回 SDK 版本、已注册 Adapter、规则和全平台注册覆盖。
- `POST /api/tasks/:taskId/compile-drafts`：逐个解析 Adapter、执行规则、写回 `platform_drafts` 的 Payload、Schema 版本、状态与校验问题。
- 存在必填错误的草稿进入 `NEEDS_REVIEW`；无错误的草稿进入 `VALIDATED`。
- 本步骤不调用平台发布 API，也不推进任务总状态；真实平台字段、类目 Schema 和四个平台的专用输出属于 Day 6。

## 验证

```bash
pnpm test:day5
pnpm lint
pnpm build
```

自动化测试覆盖规则配置校验、事实编译、缺失字段报告、12 平台兜底覆盖、重复注册拒绝和高优先级覆盖机制。
