import type { ListingDraftPayload } from '../domain/listing.ts';
import { buildAmazonSandboxListingRequest } from './amazon-us-sandbox.ts';
import { amazonSpApiHeaders } from './amazon-us-http.ts';
import { requireAmazonMarket } from './amazon-markets.ts';
import { exchangeAmazonLwaAccessToken, type AmazonListingIssue, type AmazonUsSellerConnection } from './amazon-us-listings.ts';

export interface AmazonLivePreviewResult {
  market: string;
  marketplaceId: string;
  productType: string;
  schemaVersion: string | null;
  schemaChecksum: string | null;
  requiredAttributes: string[];
  missingRequiredAttributes: string[];
  unmappedAttributes: string[];
  preview: { status: 'ACCEPTED' | 'INVALID'; issues: AmazonListingIssue[] } | null;
}

interface ProductTypeDefinitionResponse {
  productTypeVersion?: { version?: string };
  schema?: { link?: { resource?: string }; checksum?: string };
}

/** Production preflight only. Never calls putListingsItem without VALIDATION_PREVIEW. */
export async function previewAmazonListingAgainstLiveRules(
  connection: AmazonUsSellerConnection,
  payload: ListingDraftPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<AmazonLivePreviewResult> {
  const request = buildAmazonSandboxListingRequest(payload);
  const market = requireAmazonMarket(request.marketCode);
  const endpoint = `https://sellingpartnerapi-${market.region}.amazon.com`;
  const token = await exchangeAmazonLwaAccessToken(connection, fetchImpl);
  const definitionUrl = new URL(`/definitions/2020-09-01/productTypes/${encodeURIComponent(request.productType)}`, endpoint);
  definitionUrl.searchParams.set('marketplaceIds', market.marketplaceId);
  definitionUrl.searchParams.set('requirements', 'LISTING');
  definitionUrl.searchParams.set('requirementsEnforced', 'ENFORCED');
  definitionUrl.searchParams.set('locale', market.locale.replace('-', '_'));
  definitionUrl.searchParams.set('sellerId', connection.sellerId);
  definitionUrl.searchParams.set('parentageLevel', 'NONE');
  const definitionResponse = await fetchImpl(definitionUrl, { headers: amazonSpApiHeaders(token) });
  if (!definitionResponse.ok) throw new Error(`Amazon 正式商品类型定义读取失败（HTTP ${definitionResponse.status}）`);
  const definition = await definitionResponse.json() as ProductTypeDefinitionResponse;
  const schemaUrl = definition.schema?.link?.resource;
  if (!schemaUrl || !/^https:\/\//i.test(schemaUrl)) throw new Error('Amazon 未返回有效的商品类型 Schema 链接');
  const schemaResponse = await fetchImpl(schemaUrl, { headers: { accept: 'application/json' } });
  if (!schemaResponse.ok) throw new Error(`Amazon 正式商品类型 Schema 下载失败（HTTP ${schemaResponse.status}）`);
  const schema = await schemaResponse.json() as { required?: unknown; properties?: unknown };
  if (!schema || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    throw new Error('Amazon 正式商品类型 Schema 格式无效');
  }
  const properties = schema.properties as Record<string, unknown>;
  const requiredAttributes = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
  const attributeNames = Object.keys(request.body.attributes);
  const missingRequiredAttributes = requiredAttributes.filter((key) => !(key in request.body.attributes));
  const unmappedAttributes = attributeNames.filter((key) => !(key in properties));
  const base: Omit<AmazonLivePreviewResult, 'preview'> = {
    market: market.label,
    marketplaceId: market.marketplaceId,
    productType: request.productType,
    schemaVersion: definition.productTypeVersion?.version ?? null,
    schemaChecksum: definition.schema?.checksum ?? null,
    requiredAttributes,
    missingRequiredAttributes,
    unmappedAttributes,
  };
  // Local checks cover top-level names only. Amazon's official preview checks conditional and nested rules.
  if (unmappedAttributes.length) return { ...base, preview: null };
  const url = new URL(`/listings/2021-08-01/items/${encodeURIComponent(connection.sellerId)}/${encodeURIComponent(request.sku)}`, endpoint);
  url.searchParams.set('marketplaceIds', market.marketplaceId);
  url.searchParams.set('mode', 'VALIDATION_PREVIEW');
  url.searchParams.set('issueLocale', market.locale.replace('-', '_'));
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: { ...amazonSpApiHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(request.body),
  });
  if (!response.ok) throw new Error(`Amazon 正式 Listing 预校验失败（HTTP ${response.status}）`);
  const preview = await response.json() as { status?: unknown; issues?: unknown };
  if (preview.status !== 'ACCEPTED' && preview.status !== 'INVALID') throw new Error('Amazon 正式预校验返回了无法识别的状态');
  return {
    ...base,
    preview: {
      status: preview.status,
      issues: Array.isArray(preview.issues) ? preview.issues.filter((issue): issue is AmazonListingIssue => Boolean(issue && typeof issue === 'object')) : [],
    },
  };
}
