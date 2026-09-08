import type { AppBindings } from '../../db/client.ts';
import type { ListingDraftPayload } from '../domain/listing.ts';

export const DEFAULT_SHOPIFY_API_VERSION = '2026-07';

export interface ShopifyDevConfig {
  storeDomain: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
}

export interface ShopifyDevStatus {
  provider: 'SHOPIFY_DEV';
  configured: boolean;
  storeDomain: string | null;
  apiVersion: string;
  missing: string[];
}

export interface ShopifyDevPublication {
  provider: 'SHOPIFY_DEV';
  productId: string;
  variantId: string | null;
  handle: string | null;
  adminUrl: string | null;
  status: 'DRAFT_CREATED';
  createdAt: string;
  warnings: string[];
}

type ShopifyGraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

function normalizeStoreDomain(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const domain = normalized.endsWith('.myshopify.com') ? normalized : `${normalized}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error('SHOPIFY_DEV_STORE_DOMAIN 必须是有效的 *.myshopify.com 测试店铺域名');
  }
  return domain;
}

function normalizeApiVersion(value?: string): string {
  const version = value?.trim() || DEFAULT_SHOPIFY_API_VERSION;
  if (!/^\d{4}-(01|04|07|10)$/.test(version)) {
    throw new Error('SHOPIFY_API_VERSION 格式无效，应类似 2026-07');
  }
  return version;
}

export function getShopifyDevStatus(bindings: Partial<AppBindings>): ShopifyDevStatus {
  const values = {
    SHOPIFY_DEV_STORE_DOMAIN: bindings.SHOPIFY_DEV_STORE_DOMAIN?.trim() ?? '',
    SHOPIFY_DEV_CLIENT_ID: bindings.SHOPIFY_DEV_CLIENT_ID?.trim() ?? '',
    SHOPIFY_DEV_CLIENT_SECRET: bindings.SHOPIFY_DEV_CLIENT_SECRET?.trim() ?? '',
  };
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
  let storeDomain: string | null = null;
  if (values.SHOPIFY_DEV_STORE_DOMAIN) storeDomain = normalizeStoreDomain(values.SHOPIFY_DEV_STORE_DOMAIN);
  return {
    provider: 'SHOPIFY_DEV',
    configured: missing.length === 0,
    storeDomain,
    apiVersion: normalizeApiVersion(bindings.SHOPIFY_API_VERSION),
    missing,
  };
}

export function loadShopifyDevConfig(bindings: Partial<AppBindings>): ShopifyDevConfig {
  const status = getShopifyDevStatus(bindings);
  if (!status.configured || !status.storeDomain) {
    throw new Error(`Shopify Dev Store 尚未配置：缺少 ${status.missing.join('、')}。请先创建免费开发店铺并配置连接信息。`);
  }
  return {
    storeDomain: status.storeDomain,
    clientId: bindings.SHOPIFY_DEV_CLIENT_ID!.trim(),
    clientSecret: bindings.SHOPIFY_DEV_CLIENT_SECRET!.trim(),
    apiVersion: status.apiVersion,
  };
}

function textField(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(fields: Record<string, unknown>, key: string): string[] | undefined {
  const value = fields[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function numericField(fields: Record<string, unknown>, key: string): number | undefined {
  const value = fields[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function buildShopifyProductInput(payload: ListingDraftPayload, draftId: string): Record<string, unknown> {
  const fields = payload.fields;
  const title = textField(fields, 'title') ?? textField(fields, 'product_name');
  if (!title) throw new Error('Shopify Listing 缺少商品标题，无法创建测试草稿');
  const tags = [...new Set([...(stringList(fields, 'tags') ?? []), 'skuflow-test', `skuflow-draft-${draftId}`])];
  const seoTitle = textField(fields, 'seo_title');
  const seoDescription = textField(fields, 'seo_description');
  return {
    title,
    descriptionHtml: textField(fields, 'body_html'),
    vendor: textField(fields, 'vendor'),
    productType: textField(fields, 'product_type'),
    tags,
    status: 'DRAFT',
    ...(seoTitle || seoDescription ? { seo: { title: seoTitle, description: seoDescription } } : {}),
  };
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string; error_description?: string };
    return body.error_description || body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function exchangeAccessToken(config: ShopifyDevConfig, fetchImpl: typeof fetch): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const response = await fetchImpl(`https://${config.storeDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`Shopify 测试店铺认证失败：${await responseMessage(response)}`);
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error('Shopify 测试店铺认证失败：未返回 access_token');
  return payload.access_token;
}

async function shopifyGraphql<T>(config: ShopifyDevConfig, token: string, query: string, variables: Record<string, unknown>, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`https://${config.storeDomain}/admin/api/${config.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Shopify GraphQL 调用失败：${await responseMessage(response)}`);
  const envelope = await response.json() as ShopifyGraphqlEnvelope<T>;
  if (envelope.errors?.length) throw new Error(`Shopify GraphQL 调用失败：${envelope.errors.map((item) => item.message).filter(Boolean).join('；')}`);
  if (!envelope.data) throw new Error('Shopify GraphQL 调用失败：响应中没有 data');
  return envelope.data;
}

const CREATE_PRODUCT = `mutation CreateSkuFlowProduct($product: ProductCreateInput!) {
  productCreate(product: $product) {
    product { id title handle status variants(first: 1) { nodes { id } } }
    userErrors { field message }
  }
}`;

const UPDATE_INITIAL_VARIANT = `mutation UpdateSkuFlowVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}`;

export async function publishShopifyDevDraft(input: {
  config: ShopifyDevConfig;
  payload: ListingDraftPayload;
  draftId: string;
  now?: string;
}, fetchImpl: typeof fetch = fetch): Promise<ShopifyDevPublication> {
  const token = await exchangeAccessToken(input.config, fetchImpl);
  const created = await shopifyGraphql<{
    productCreate: {
      product: { id: string; handle: string | null; status: string; variants: { nodes: Array<{ id: string }> } } | null;
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  }>(input.config, token, CREATE_PRODUCT, { product: buildShopifyProductInput(input.payload, input.draftId) }, fetchImpl);
  const createErrors = created.productCreate.userErrors;
  if (createErrors.length) throw new Error(`Shopify 商品草稿创建失败：${createErrors.map((item) => item.message).join('；')}`);
  const product = created.productCreate.product;
  if (!product) throw new Error('Shopify 商品草稿创建失败：未返回商品');
  if (product.status !== 'DRAFT') throw new Error(`Shopify 返回了非草稿状态：${product.status}`);

  const warnings: string[] = [];
  const variantId = product.variants.nodes[0]?.id ?? null;
  const sku = textField(input.payload.fields, 'variant_sku');
  const price = numericField(input.payload.fields, 'variant_price');
  if (variantId && (sku || price !== undefined)) {
    const variant = {
      id: variantId,
      ...(price !== undefined ? { price: String(price) } : {}),
      ...(sku ? { inventoryItem: { sku, tracked: true } } : {}),
    };
    try {
      const updated = await shopifyGraphql<{
        productVariantsBulkUpdate: { productVariants: Array<{ id: string }>; userErrors: Array<{ message: string }> };
      }>(input.config, token, UPDATE_INITIAL_VARIANT, { productId: product.id, variants: [variant] }, fetchImpl);
      if (updated.productVariantsBulkUpdate.userErrors.length) {
        warnings.push(`SKU/售价未完全同步：${updated.productVariantsBulkUpdate.userErrors.map((item) => item.message).join('；')}`);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : 'SKU/售价同步失败');
    }
  }
  if (numericField(input.payload.fields, 'inventory_quantity') !== undefined) {
    warnings.push('库存数量暂存于 SKUFlow，当前测试连接未修改 Shopify 库存地点数量。');
  }
  const numericProductId = product.id.split('/').pop();
  return {
    provider: 'SHOPIFY_DEV',
    productId: product.id,
    variantId,
    handle: product.handle,
    adminUrl: numericProductId ? `https://${input.config.storeDomain}/admin/products/${numericProductId}` : null,
    status: 'DRAFT_CREATED',
    createdAt: input.now ?? new Date().toISOString(),
    warnings,
  };
}
