import { exchangeAccessToken, shopifyGraphql, type ShopifyDevConfig } from './shopify-dev.ts';
import type { MockListingSchema, ListingFieldDefinition } from '../domain/listing.ts';

const TYPES = ['ProductCreateInput', 'SEOInput', 'ProductVariantsBulkInput', 'InventoryItemInput', 'ProductSetInput', 'ProductVariantSetInput', 'ProductSetInventoryInput', 'FileSetInput', 'WeightInput'];
export async function fetchShopifyListingSchema(config: ShopifyDevConfig, input: { market: string; categoryLabel?: string | null }, fetchImpl: typeof fetch = fetch): Promise<MockListingSchema> {
  const token = await exchangeAccessToken(config, fetchImpl);
  const query = `query SkuFlowSchema { shop { currencyCode } currentAppInstallation { accessScopes { handle } } ${TYPES.map((name) => `${name}: __type(name: "${name}") { inputFields { name description type { kind name ofType { kind name ofType { kind name } } } } }`).join(' ')} }`;
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
  const scopes = (data as any).currentAppInstallation?.accessScopes?.map((s: {handle: string}) => s.handle) ?? [];
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
  const add = (apiType: string, apiKey: string, field: ListingFieldDefinition) => {
    if (data[apiType].inputFields.some(f => f.name === apiKey)) fields.push({...field, helpText: field.helpText ?? `发布后核对 ${field.label}`});
  };
  add('ProductSetInput','category',{key:'category_id',label:'Shopify 标准分类',type:'string',source:'SELLER_INPUT',required:false,lookup:'categories',group:'商品组织'});
  add('ProductSetInput','collections',{key:'collection_ids',label:'商品系列',type:'string_array',source:'SELLER_INPUT',required:false,lookup:'collections',group:'商品组织'});
  add('ProductSetInput','handle',{key:'handle',label:'商品网址名称',type:'string',source:'SELLER_INPUT',required:false,helpText:'留空时由 Shopify 根据标题生成'});
  add('ProductSetInput','templateSuffix',{key:'template_suffix',label:'主题模板后缀',type:'string',source:'SELLER_INPUT',required:false,helpText:'留空使用店铺默认商品模板'});
  add('ProductVariantSetInput','barcode',{key:'barcode',label:'条码',type:'string',source:'PRODUCT_FACT',factKey:'product.barcode',required:false});
  add('ProductVariantSetInput','compareAtPrice',{key:'compare_at_price',label:'划线价',type:'number',source:'SELLER_INPUT',unit:data.shop.currencyCode,required:false});
  add('InventoryItemInput','cost',{key:'unit_cost',label:'单位成本',type:'number',source:'SELLER_INPUT',unit:data.shop.currencyCode,required:false});
  add('ProductVariantSetInput','taxable',{key:'taxable',label:'是否收税',type:'boolean',source:'SELLER_INPUT',required:true});
  add('InventoryItemInput','requiresShipping',{key:'requires_shipping',label:'是否需要运输',type:'boolean',source:'SELLER_INPUT',required:true});
  add('InventoryItemInput','measurement',{key:'shipping_weight',label:'运输重量（kg）',type:'number',source:'PRODUCT_FACT',factKey:'shipping.weight_kg',required:false,helpText:'使用实际运输重量；不会把面料克重当运输重量'});
  add('InventoryItemInput','countryCodeOfOrigin',{key:'country_of_origin',label:'原产国（两位代码）',type:'string',source:'PRODUCT_FACT',factKey:'product.country_code',required:false});
  add('InventoryItemInput','harmonizedSystemCode',{key:'hs_code',label:'海关 HS 编码',type:'string',source:'PRODUCT_FACT',factKey:'product.hs_code',required:false});
  add('InventoryItemInput','tracked',{key:'inventory_tracked',label:'是否跟踪库存',type:'boolean',source:'SELLER_INPUT',required:true});
  add('ProductVariantSetInput','inventoryPolicy',{key:'inventory_policy',label:'缺货时是否继续销售',type:'string',source:'SELLER_INPUT',required:false,options:[{value:'DENY',label:'停止销售'},{value:'CONTINUE',label:'允许继续销售'}]});
  add('ProductSetInventoryInput','locationId',{key:'inventory_location',label:'库存地点',type:'string',source:'SELLER_INPUT',required:false,lookup:'locations',helpText:scopes.includes('write_inventory') ? '请明确选择本次写入的库存地点' : '需授权 write_inventory 和 read_locations 才能同步库存'});
  add('ProductSetInventoryInput','quantity',{key:'inventory_quantity',label:'库存数量',type:'number',source:'SELLER_INPUT',required:false});
  add('ProductSetInput','variants',{key:'variants',label:'尺码/颜色等变体',type:'variants',source:'SELLER_INPUT',required:false,helpText:'没有不同规格可留空。每行一个实际销售规格，分别填写 SKU、售价与库存；不自动拼出未经确认的组合'});
  if (!fields.some((field) => field.key === 'title')) throw new Error('Shopify 缺少可写入的标题字段');
  return { mode: 'SHOPIFY_API', platformId: 'shopify', platformName: 'Shopify', market: input.market,
    locale: 'zh-CN', categoryId: 'shopify-product', categoryLabel: input.categoryLabel || '商品',
    schemaVersion: `shopify-admin-${config.apiVersion}`, storeDomain: config.storeDomain, fetchedAt: new Date().toISOString(), fields: fields.sort((a,b) => (a.key === 'title' ? -1 : b.key === 'title' ? 1 : 0)),
    accessScopes: scopes,
    unsupportedFields: ['订阅销售计划、组合套装、礼品卡专用配置', '分类元字段和自定义元字段（需定义及数据类型）', '销售渠道、市场价格及语言翻译（当前仍创建中文测试草稿）'],
  };
}
