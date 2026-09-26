import { amazonSpApiHeaders } from './amazon-us-http.ts';

/** Amazon US listing rules come from Product Type Definitions, never from the demo field list. */
export const AMAZON_US_MARKETPLACE_ID = 'ATVPDKIKX0DER';
export const AMAZON_NA_SP_API_ENDPOINT = 'https://sellingpartnerapi-na.amazon.com';

export type AmazonParentageLevel = 'NONE' | 'PARENT' | 'CHILD';

export interface AmazonUsProductTypeDefinition {
  productType: string;
  marketplaceId: typeof AMAZON_US_MARKETPLACE_ID;
  parentageLevel: AmazonParentageLevel;
  version: string | null;
  checksum: string | null;
  schema: Record<string, unknown>;
}

interface ProductTypeResponse {
  productType?: string;
  productTypeVersion?: { version?: string };
  schema?: { link?: { resource?: string }; checksum?: string };
}

/** Requires an authorized seller's Product Listing role and an LWA access token. */
export async function fetchAmazonUsProductTypeDefinition(input: {
  accessToken: string;
  productType: string;
  sellerId?: string;
  parentageLevel: AmazonParentageLevel;
}, fetchImpl: typeof fetch = fetch): Promise<AmazonUsProductTypeDefinition> {
  const productType = input.productType.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(productType)) throw new Error('Amazon 商品类型无效');
  if (!input.accessToken.trim()) throw new Error('缺少 Amazon 卖家授权');

  const url = new URL(`/definitions/2020-09-01/productTypes/${productType}`, AMAZON_NA_SP_API_ENDPOINT);
  url.searchParams.set('marketplaceIds', AMAZON_US_MARKETPLACE_ID);
  url.searchParams.set('requirements', 'LISTING');
  url.searchParams.set('requirementsEnforced', 'ENFORCED');
  url.searchParams.set('locale', 'en_US');
  url.searchParams.set('parentageLevel', input.parentageLevel);
  if (input.sellerId?.trim()) url.searchParams.set('sellerId', input.sellerId.trim());

  const response = await fetchImpl(url, {
    headers: amazonSpApiHeaders(input.accessToken),
  });
  if (!response.ok) throw new Error(`Amazon 商品类型规则读取失败（HTTP ${response.status}）`);
  const definition = await response.json() as ProductTypeResponse;
  const resource = definition.schema?.link?.resource;
  if (!resource || !/^https:\/\//i.test(resource)) throw new Error('Amazon 商品类型规则缺少有效的 Schema 链接');

  // The document URL is temporary. Return its contents rather than persisting the URL.
  const schemaResponse = await fetchImpl(resource, { headers: { accept: 'application/json' } });
  if (!schemaResponse.ok) throw new Error(`Amazon 商品类型 Schema 下载失败（HTTP ${schemaResponse.status}）`);
  const schema = await schemaResponse.json() as Record<string, unknown>;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !schema.properties) {
    throw new Error('Amazon 商品类型 Schema 格式无效');
  }
  return {
    productType,
    marketplaceId: AMAZON_US_MARKETPLACE_ID,
    parentageLevel: input.parentageLevel,
    version: definition.productTypeVersion?.version ?? null,
    checksum: definition.schema?.checksum ?? null,
    schema,
  };
}
