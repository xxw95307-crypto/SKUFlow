import type { ListingFieldDefinition, MockListingSchema } from '../domain/listing';
import type { PlatformId } from '../domain/platform';
import { getPlatformProfile } from '../platforms/registry.ts';
import { marketLocale } from '../localization/market-locales.ts';

const fact = (key: string, label: string, factKey: string, required = false, extra: Partial<ListingFieldDefinition> = {}): ListingFieldDefinition => ({
  key, label, factKey, required, source: 'PRODUCT_FACT', type: 'string', ...extra,
});
const ai = (key: string, label: string, type: ListingFieldDefinition['type'], required = true, extra: Partial<ListingFieldDefinition> = {}): ListingFieldDefinition => ({
  key, label, type, required, source: 'AI_GENERATED', ...extra,
});
const seller = (key: string, label: string, type: ListingFieldDefinition['type'], required = true, extra: Partial<ListingFieldDefinition> = {}): ListingFieldDefinition => ({
  key, label, type, required, source: 'SELLER_INPUT', ...extra,
});
const productNameField = () => fact('product_name', '商品名称', 'product.name', true, {
  maxLength: 120,
  allowAiInference: true,
  helpText: '由模型综合图片和文档生成的统一商品名称。',
});

const amazonFields: ListingFieldDefinition[] = [
  productNameField(),
  ai('item_name', '商品标题', 'string', true, { maxLength: 200, helpText: '根据可信商品事实生成，适配站内搜索与可读性。' }),
  fact('brand_name', '品牌', 'product.brand', true, { maxLength: 120, allowAiInference: true }),
  fact('model_name', '型号', 'product.model', false, { maxLength: 120, allowAiInference: true }),
  ai('bullet_points', '五点描述', 'string_array', true, { minItems: 5, maxItems: 5, itemMaxLength: 500 }),
  ai('product_description', '商品描述', 'text', true, { maxLength: 2000 }),
  ai('generic_keywords', '后台搜索词', 'string', false, { maxLength: 249 }),
  fact('material_type', '材质', 'product.material', false, { allowAiInference: true }),
  fact('color_name', '颜色', 'product.color', false, { allowAiInference: true }),
  fact('capacity', '容量', 'product.capacity', false, { allowAiInference: true }),
  seller('seller_sku', '卖家 SKU', 'string', true, { maxLength: 80, placeholder: '由卖家填写，例如 BG-MINI-PINK' }),
  seller('standard_price', '售价', 'number', true, { unit: 'USD', placeholder: '由卖家填写' }),
  seller('quantity', '库存', 'number', true, { placeholder: '由卖家填写' }),
];

const tiktokFields: ListingFieldDefinition[] = [
  productNameField(),
  ai('title', '短标题', 'string', true, { maxLength: 188 }),
  ai('description', '商品详情', 'text', true, { maxLength: 3000 }),
  ai('selling_points', '核心卖点', 'string_array', true, { minItems: 3, maxItems: 5, itemMaxLength: 300 }),
  ai('video_hook', '短视频开场文案', 'string', false, { maxLength: 150 }),
  fact('brand', '品牌', 'product.brand', true, { allowAiInference: true }),
  fact('material', '材质', 'product.material', false, { allowAiInference: true }),
  fact('color', '颜色', 'product.color', false, { allowAiInference: true }),
  fact('capacity', '容量', 'product.capacity', false, { allowAiInference: true }),
  seller('seller_sku', '卖家 SKU', 'string', true, { maxLength: 80 }),
  seller('price', '售价', 'number', true, { unit: 'USD' }),
  seller('stock', '库存', 'number', true),
];

const shopifyFields: ListingFieldDefinition[] = [
  productNameField(),
  ai('title', '商品标题', 'string', true, { maxLength: 255 }),
  ai('body_html', '商品详情', 'text', true, { maxLength: 5000 }),
  ai('tags', '商品标签', 'string_array', false, { maxItems: 12, itemMaxLength: 60 }),
  ai('seo_title', 'SEO 标题', 'string', true, { maxLength: 70 }),
  ai('seo_description', 'SEO 描述', 'text', true, { maxLength: 160 }),
  fact('vendor', '品牌/供应商', 'product.brand', true, { allowAiInference: true }),
  fact('product_type', '商品类型', 'product.category_hint', true, { allowAiInference: true }),
  seller('variant_sku', 'SKU', 'string', true, { maxLength: 80 }),
  seller('variant_price', '售价', 'number', true, { unit: 'USD' }),
  seller('inventory_quantity', '库存', 'number', true),
];

const shopeeFields: ListingFieldDefinition[] = [
  productNameField(),
  ai('item_name', '平台商品标题', 'string', true, { maxLength: 120 }),
  ai('description', '商品描述', 'text', true, { maxLength: 3000 }),
  ai('highlights', '商品卖点', 'string_array', true, { minItems: 3, maxItems: 5, itemMaxLength: 300 }),
  fact('brand', '品牌', 'product.brand', true, { allowAiInference: true }),
  fact('category', '商品类目', 'product.category_hint', true, { allowAiInference: true }),
  fact('material', '材质', 'product.material', false, { allowAiInference: true }),
  fact('color', '颜色', 'product.color', false, { allowAiInference: true }),
  fact('weight', '商品重量', 'product.weight.net', false, { allowAiInference: true }),
  seller('seller_sku', '卖家 SKU', 'string', true, { maxLength: 80 }),
  seller('price', '售价', 'number', true, { unit: 'SGD' }),
  seller('stock', '库存', 'number', true),
];

const genericFields: ListingFieldDefinition[] = [
  productNameField(),
  ai('title', '商品标题', 'string', true, { maxLength: 180 }),
  ai('description', '商品描述', 'text', true, { maxLength: 3000 }),
  ai('selling_points', '核心卖点', 'string_array', true, { minItems: 3, maxItems: 5, itemMaxLength: 300 }),
  fact('brand', '品牌', 'product.brand', true, { allowAiInference: true }),
  fact('category', '商品类目', 'product.category_hint', true, { allowAiInference: true }),
  fact('material', '材质', 'product.material', false, { allowAiInference: true }),
  fact('color', '颜色', 'product.color', false, { allowAiInference: true }),
  seller('seller_sku', '卖家 SKU', 'string', true),
  seller('price', '售价', 'number', true),
  seller('stock', '库存', 'number', true),
];

function fieldsFor(platformId: PlatformId): ListingFieldDefinition[] {
  if (platformId === 'amazon') return amazonFields;
  if (platformId === 'tiktok-shop') return tiktokFields;
  if (platformId === 'shopify') return shopifyFields;
  if (platformId === 'shopee') return shopeeFields;
  return genericFields;
}

export function resolveMockListingSchema(input: {
  platformId: PlatformId;
  market: string;
  categoryId?: string | null;
  categoryLabel?: string | null;
}): MockListingSchema {
  const platform = getPlatformProfile(input.platformId);
  const categoryLabel = input.categoryLabel?.trim() || '通用商品';
  const categoryId = input.categoryId?.trim() || `mock-${categoryLabel.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'general'}`;
  return {
    mode: 'MOCK',
    platformId: input.platformId,
    platformName: platform.name,
    market: input.market,
    locale: marketLocale(input.market).locale,
    categoryId,
    categoryLabel,
    schemaVersion: `mock-${input.platformId}-${marketLocale(input.market).locale.toLowerCase()}-v3`,
    fields: fieldsFor(input.platformId).map((field) => ({ ...field })),
  };
}

export function isMockRichPlatform(platformId: PlatformId): boolean {
  return ['amazon', 'tiktok-shop', 'shopify', 'shopee'].includes(platformId);
}
