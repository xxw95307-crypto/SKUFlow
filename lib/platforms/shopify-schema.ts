import { exchangeAccessToken, shopifyGraphql, type ShopifyDevConfig } from './shopify-dev.ts';
import type { MockListingSchema, ListingFieldDefinition } from '../domain/listing.ts';

const TYPES = ['ProductCreateInput', 'SEOInput', 'ProductVariantsBulkInput', 'InventoryItemInput'];
export async function fetchShopifyListingSchema(config: ShopifyDevConfig, input: { market: string; categoryLabel?: string | null }, fetchImpl: typeof fetch = fetch): Promise<MockListingSchema> {
  const token = await exchangeAccessToken(config, fetchImpl);
  const query = `query SkuFlowSchema { shop { currencyCode } ${TYPES.map((name) => `${name}: __type(name: "${name}") { inputFields { name description type { kind name ofType { kind name ofType { kind name } } } } }`).join(' ')} }`;
  type ApiField = { name: string; description: string; type: { kind: string; name: string | null; ofType?: { kind: string; name: string | null } } };
  const data = await shopifyGraphql<Record<string, { inputFields: ApiField[] }> & { shop: { currencyCode: string } }>(config, token, query, {}, fetchImpl);
  for (const name of TYPES) if (!data[name]?.inputFields?.length) throw new Error(`Shopify 未返回 ${name} 字段定义，不能生成审核稿`);
  const mapping: Record<string, [string, string, ListingFieldDefinition['source'], string?]> = {
    'ProductCreateInput.title': ['title', '商品标题', 'AI_GENERATED'],
    'ProductCreateInput.descriptionHtml': ['body_html', '商品描述', 'AI_GENERATED'],
    'ProductCreateInput.tags': ['tags', '商品标签', 'AI_GENERATED'],
    'ProductCreateInput.vendor': ['vendor', '供应商/品牌', 'PRODUCT_FACT', 'product.brand'],
    'ProductCreateInput.productType': ['product_type', '商品类型', 'PRODUCT_FACT', 'product.category_hint'],
    'SEOInput.title': ['seo_title', '搜索引擎标题', 'AI_GENERATED'],
    'SEOInput.description': ['seo_description', '搜索引擎描述', 'AI_GENERATED'],
    'ProductVariantsBulkInput.price': ['variant_price', '售价', 'SELLER_INPUT'],
    'InventoryItemInput.sku': ['variant_sku', 'SKU', 'SELLER_INPUT'],
  };
  const fields: ListingFieldDefinition[] = [];
  for (const type of TYPES) for (const field of data[type].inputFields) {
    const path = `${type}.${field.name}`;
    const mapped = mapping[path];
    if (!mapped) continue;
    const [key, label, source, factKey] = mapped;
    fields.push({ key, label, source, factKey, required: field.type.kind === 'NON_NULL' || key === 'title',
      type: key === 'tags' ? 'string_array' : key === 'variant_price' ? 'number' : ['body_html', 'seo_description'].includes(key) ? 'text' : 'string',
      ...(key === 'variant_price' ? { unit: data.shop.currencyCode } : {}),
      helpText: `将同步到 Shopify · ${path}${key === 'variant_price' ? ` · 店铺币种 ${data.shop.currencyCode}` : ''}`,
    });
  }
  if (!fields.some((field) => field.key === 'title')) throw new Error('Shopify 缺少可写入的标题字段');
  return { mode: 'SHOPIFY_API', platformId: 'shopify', platformName: 'Shopify', market: input.market,
    locale: 'zh-CN', categoryId: 'shopify-product', categoryLabel: input.categoryLabel || '商品',
    schemaVersion: `shopify-admin-${config.apiVersion}`, storeDomain: config.storeDomain, fetchedAt: new Date().toISOString(), fields,
    unsupportedFields: [...data.ProductCreateInput.inputFields.filter((f) => !mapping[`ProductCreateInput.${f.name}`] && !['seo', 'status'].includes(f.name)).map((f) => f.name), '库存地点数量', '商品图片/媒体', '多变体选项', '目标市场配置与语言翻译（本次按审核原文写入）'],
  };
}
