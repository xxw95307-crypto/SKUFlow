import { AMAZON_NA_SP_API_ENDPOINT, AMAZON_US_MARKETPLACE_ID } from './amazon-us-product-types.ts';
import { amazonSpApiHeaders } from './amazon-us-http.ts';

export interface AmazonUsSellerConnection {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  sellerId: string;
}

export interface AmazonListingInput {
  sku: string;
  productType: string;
  attributes: Record<string, unknown>;
}

export interface AmazonListingIssue {
  code?: string;
  message?: string;
  severity?: string;
  attributeNames?: string[];
}

export interface AmazonListingResponse {
  sku?: string;
  status?: string;
  submissionId?: string;
  issues?: AmazonListingIssue[];
  [key: string]: unknown;
}

function assertConnection(connection: AmazonUsSellerConnection): void {
  if (!connection.clientId || !connection.clientSecret || !connection.refreshToken || !connection.sellerId) {
    throw new Error('尚未连接已授权的 Amazon 美国站卖家账户');
  }
}

function listingUrl(sellerId: string, sku: string): URL {
  if (!sellerId.trim() || !sku.trim()) throw new Error('Amazon 卖家 ID 和 SKU 不能为空');
  const url = new URL(
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
    AMAZON_NA_SP_API_ENDPOINT,
  );
  url.searchParams.set('marketplaceIds', AMAZON_US_MARKETPLACE_ID);
  return url;
}

export async function exchangeAmazonLwaAccessToken(
  connection: AmazonUsSellerConnection,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  assertConnection(connection);
  const response = await fetchImpl('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: connection.refreshToken,
      client_id: connection.clientId,
      client_secret: connection.clientSecret,
    }),
  });
  if (!response.ok) throw new Error(`Amazon 卖家授权令牌换取失败（HTTP ${response.status}）`);
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error('Amazon 授权服务未返回 access_token');
  return data.access_token;
}

/** PREVIEW never writes a listing. SUBMIT must only be called after seller approval. */
export async function putAmazonUsListing(
  connection: AmazonUsSellerConnection,
  input: AmazonListingInput,
  mode: 'PREVIEW' | 'SUBMIT',
  fetchImpl: typeof fetch = fetch,
): Promise<AmazonListingResponse> {
  if (!input.productType.trim() || !Object.keys(input.attributes).length) {
    throw new Error('Amazon 商品类型和官方 Schema 对应的属性不能为空');
  }
  const url = listingUrl(connection.sellerId, input.sku);
  if (mode === 'PREVIEW') url.searchParams.set('mode', 'VALIDATION_PREVIEW');
  url.searchParams.set('issueLocale', 'en_US');
  const token = await exchangeAmazonLwaAccessToken(connection, fetchImpl);
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: { ...amazonSpApiHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ productType: input.productType, requirements: 'LISTING', attributes: input.attributes }),
  });
  if (!response.ok) throw new Error(`Amazon Listing ${mode === 'PREVIEW' ? '预校验' : '提交'}失败（HTTP ${response.status}）`);
  const result = await response.json() as AmazonListingResponse;
  if (!result || typeof result !== 'object' || !['ACCEPTED', 'INVALID'].includes(result.status ?? '')) {
    throw new Error('Amazon Listing 返回了无法识别的提交状态');
  }
  return result;
}

export async function getAmazonUsListing(
  connection: AmazonUsSellerConnection,
  sku: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const url = listingUrl(connection.sellerId, sku);
  url.searchParams.set('issueLocale', 'en_US');
  url.searchParams.set('includedData', 'summaries,attributes,issues,offers,fulfillmentAvailability');
  const token = await exchangeAmazonLwaAccessToken(connection, fetchImpl);
  const response = await fetchImpl(url, { headers: amazonSpApiHeaders(token) });
  if (!response.ok) throw new Error(`Amazon Listing 回读失败（HTTP ${response.status}）`);
  const data = await response.json() as Record<string, unknown>;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Amazon Listing 回读格式无效');
  return data;
}
