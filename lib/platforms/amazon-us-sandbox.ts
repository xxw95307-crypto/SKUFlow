import { amazonSpApiHeaders } from './amazon-us-http.ts';
import { amazonSandboxEndpoint, requireAmazonMarket } from './amazon-markets.ts';
import type { ListingDraftPayload } from '../domain/listing.ts';

export interface AmazonSandboxCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface AmazonSandboxSmokeResult {
  environment: 'AMAZON_STATIC_SANDBOX';
  marketplaceId: string;
  productType: string;
  productTypeStatus: number;
  listingPreviewStatus: string;
  listingIssueCodes: string[];
}

export interface AmazonSandboxListingRequest {
  marketCode: string;
  marketplaceId: string;
  currency: string;
  languageTag: string;
  sku: string;
  productType: string;
  body: {
    productType: string;
    requirements: 'LISTING';
    attributes: Record<string, unknown>;
  };
}

export interface AmazonSandboxListingResult {
  environment: 'AMAZON_STATIC_SANDBOX';
  request: AmazonSandboxListingRequest;
  response: {
    status: string;
    sandboxSku: string | null;
    submissionId: string | null;
    issueCodes: string[];
  };
}

/** A conservative suggestion for the demo adapter, never a verified Amazon category match. */
export function suggestAmazonProductType(category: string, productName = ''): string | null {
  const description = `${category} ${productName}`;
  if (/(?:T\s*-?\s*恤|短袖|上衣|衬衫|shirt|tee\b|t-shirt)/i.test(description)) return 'SHIRT';
  if (/(?:行李箱|旅行箱|拉杆箱|suitcase|luggage)/i.test(description)) return 'LUGGAGE';
  if (/(?:水杯|马克杯|咖啡杯|mug|drinking\s*cup)/i.test(description)) return 'DRINKING_CUP';
  return null;
}

function requiredText(fields: Record<string, unknown>, key: string, label: string): string {
  const value = fields[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Amazon 沙箱请求缺少${label}；请先修改并确认 Listing`);
  return value.trim();
}

/** Maps the reviewed, localized draft into the SP-API request shape; no claim of PTD compliance. */
export function buildAmazonSandboxListingRequest(payload: ListingDraftPayload): AmazonSandboxListingRequest {
  if (payload.schema.platformId !== 'amazon') throw new Error('仅支持 Amazon 沙箱测试');
  const market = requireAmazonMarket(payload.schema.market);
  const normalizeLocale = (value: string) => value.replace('_', '-').toLowerCase();
  if (payload.localization?.status !== 'READY' || normalizeLocale(payload.localization.targetLocale) !== normalizeLocale(market.locale)) {
    throw new Error(`请先完成 Amazon ${market.label}站 ${market.language} Listing 预览`);
  }
  const fields = { ...payload.fields, ...payload.localization.fields };
  const productType = requiredText(fields, 'product_type_code', '商品类型代码').toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(productType)) throw new Error('Amazon 商品类型代码只能使用大写字母、数字和下划线');
  const sku = requiredText(fields, 'seller_sku', '卖家 SKU');
  if (sku.length > 80) throw new Error('Amazon 卖家 SKU 过长');
  const title = requiredText(fields, 'item_name', '目标站点语言标题');
  const brand = requiredText(fields, 'brand_name', '品牌');
  const description = requiredText(fields, 'product_description', '目标站点语言描述');
  const bullets = fields.bullet_points;
  if (!Array.isArray(bullets) || bullets.length !== 5 || bullets.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('Amazon 五点描述需有 5 条目标站点语言内容');
  }
  const price = Number(fields.standard_price);
  const quantity = Number(fields.quantity);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Amazon 售价必须大于 0');
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('Amazon 库存必须为非负整数');
  const languageTag = market.locale.replace('-', '_');
  const text = (value: string) => [{ value, marketplace_id: market.marketplaceId, language_tag: languageTag }];
  const attributes: Record<string, unknown> = {
    item_name: text(title),
    brand: [{ value: brand, marketplace_id: market.marketplaceId }],
    bullet_point: (bullets as string[]).map((value) => ({ value: value.trim(), marketplace_id: market.marketplaceId, language_tag: languageTag })),
    product_description: text(description),
    purchasable_offer: [{ currency: market.currency, our_price: [{ schedule: [{ value_with_tax: price }] }], marketplace_id: market.marketplaceId }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity, marketplace_id: market.marketplaceId }],
  };
  if (typeof fields.generic_keywords === 'string' && fields.generic_keywords.trim()) {
    attributes.generic_keyword = text(fields.generic_keywords.trim());
  }
  return { marketCode: market.code, marketplaceId: market.marketplaceId, currency: market.currency, languageTag, sku, productType, body: { productType, requirements: 'LISTING', attributes } };
}

async function sandboxAccessToken(credentials: AmazonSandboxCredentials, fetchImpl: typeof fetch): Promise<string> {
  if (!credentials.clientId?.trim() || !credentials.clientSecret?.trim() || !credentials.refreshToken?.trim()) {
    throw new Error('缺少 Amazon 沙箱应用的 client ID、client secret 或沙箱 refresh token');
  }
  const tokenResponse = await fetchImpl('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken.trim(),
      client_id: credentials.clientId.trim(),
      client_secret: credentials.clientSecret.trim(),
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Amazon 沙箱令牌换取失败（HTTP ${tokenResponse.status}）`);
  const tokenData = await tokenResponse.json() as { access_token?: string };
  if (!tokenData.access_token) throw new Error('Amazon 授权服务未返回沙箱 access token');
  return tokenData.access_token;
}

/** Sends this reviewed Listing body to Amazon's hosted STATIC sandbox in preview mode. */
export async function submitAmazonSandboxListing(
  credentials: AmazonSandboxCredentials,
  request: AmazonSandboxListingRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AmazonSandboxListingResult> {
  const market = requireAmazonMarket(request.marketCode);
  if (request.marketplaceId !== market.marketplaceId || request.currency !== market.currency || request.languageTag !== market.locale.replace('-', '_')) {
    throw new Error('Amazon 沙箱请求的站点配置不一致');
  }
  const token = await sandboxAccessToken(credentials, fetchImpl);
  const url = new URL(`/listings/2021-08-01/items/SANDBOX_SELLER/${encodeURIComponent(request.sku)}`, amazonSandboxEndpoint(market));
  url.searchParams.set('marketplaceIds', market.marketplaceId);
  url.searchParams.set('mode', 'VALIDATION_PREVIEW');
  url.searchParams.set('issueLocale', request.languageTag);
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: { ...amazonSpApiHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(request.body),
  });
  if (!response.ok) throw new Error(`Amazon Listing 官方沙箱测试失败（HTTP ${response.status}）`);
  const data = await response.json() as { status?: unknown; sku?: unknown; submissionId?: unknown; issues?: Array<{ code?: unknown }> };
  if (typeof data.status !== 'string') throw new Error('Amazon 沙箱未返回可识别的 Listing 状态');
  return {
    environment: 'AMAZON_STATIC_SANDBOX',
    request,
    response: {
      status: data.status,
      sandboxSku: typeof data.sku === 'string' ? data.sku : null,
      submissionId: typeof data.submissionId === 'string' ? data.submissionId : null,
      issueCodes: Array.isArray(data.issues) ? data.issues.map((issue) => issue.code).filter((code): code is string => typeof code === 'string') : [],
    },
  };
}

/** Tests Amazon's canned SP-API responses; never treats them as real product rules. */
export async function runAmazonSandboxSmoke(
  credentials: AmazonSandboxCredentials,
  marketValue: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AmazonSandboxSmokeResult> {
  const market = requireAmazonMarket(marketValue);
  const endpoint = amazonSandboxEndpoint(market);
  const accessToken = await sandboxAccessToken(credentials, fetchImpl);

  const definitionUrl = new URL('/definitions/2020-09-01/productTypes/LUGGAGE', endpoint);
  definitionUrl.searchParams.set('marketplaceIds', market.marketplaceId);
  const definitionResponse = await fetchImpl(definitionUrl, {
    headers: amazonSpApiHeaders(accessToken),
  });
  if (!definitionResponse.ok) throw new Error(`Amazon 商品类型沙箱调用失败（HTTP ${definitionResponse.status}）`);
  const definition = await definitionResponse.json() as { productType?: string };
  if (definition.productType !== 'LUGGAGE') throw new Error('Amazon 商品类型沙箱返回了非预期的模拟响应');

  // The official static model matches this SKU and query to a canned INVALID response.
  // It is a transport/response-format test, not validation of the request's actual attributes.
  const previewUrl = new URL('/listings/2021-08-01/items/SANDBOX_SELLER/VALIDATION_INVALID', endpoint);
  previewUrl.searchParams.set('marketplaceIds', market.marketplaceId);
  previewUrl.searchParams.set('includedData', 'identifiers,issues');
  previewUrl.searchParams.set('mode', 'VALIDATION_PREVIEW');
  const previewResponse = await fetchImpl(previewUrl, {
    method: 'PUT',
    headers: { ...amazonSpApiHeaders(accessToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      productType: 'LUGGAGE',
      requirements: 'LISTING',
      attributes: { fake_attribute: [{ value: 'sandbox-only' }] },
    }),
  });
  if (!previewResponse.ok) throw new Error(`Amazon Listing 沙箱预览失败（HTTP ${previewResponse.status}）`);
  const preview = await previewResponse.json() as { status?: string; issues?: Array<{ code?: string }> };
  if (!preview.status || !Array.isArray(preview.issues)) throw new Error('Amazon Listing 沙箱返回格式无效');

  return {
    environment: 'AMAZON_STATIC_SANDBOX',
    marketplaceId: market.marketplaceId,
    productType: definition.productType,
    productTypeStatus: definitionResponse.status,
    listingPreviewStatus: preview.status,
    listingIssueCodes: preview.issues.map((issue) => issue.code).filter((code): code is string => Boolean(code)),
  };
}

export function runAmazonUsSandboxSmoke(credentials: AmazonSandboxCredentials, fetchImpl: typeof fetch = fetch): Promise<AmazonSandboxSmokeResult> {
  return runAmazonSandboxSmoke(credentials, 'US', fetchImpl);
}
