import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAmazonSandboxListingRequest, runAmazonUsSandboxSmoke, submitAmazonSandboxListing, suggestAmazonProductType } from '../lib/platforms/amazon-us-sandbox.ts';
import { amazonMarkets, requireAmazonMarket } from '../lib/platforms/amazon-markets.ts';
import type { ListingDraftPayload } from '../lib/domain/listing.ts';

const credentials = { clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh' };

test('sandbox smoke uses only Amazon sandbox endpoint and canned preview case', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchStub = (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(resource));
    calls.push({ url, init });
    if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'sandbox-access' });
    if (url.pathname.startsWith('/definitions/')) return Response.json({ productType: 'LUGGAGE' });
    return Response.json({ status: 'INVALID', issues: [{ code: '90220' }] });
  }) as typeof fetch;

  const result = await runAmazonUsSandboxSmoke(credentials, fetchStub);
  assert.equal(result.environment, 'AMAZON_STATIC_SANDBOX');
  assert.equal(result.listingPreviewStatus, 'INVALID');
  assert.deepEqual(result.listingIssueCodes, ['90220']);
  assert.deepEqual(calls.map((call) => call.url.hostname), [
    'api.amazon.com', 'sandbox.sellingpartnerapi-na.amazon.com', 'sandbox.sellingpartnerapi-na.amazon.com',
  ]);
  assert.equal(calls[2].url.searchParams.get('mode'), 'VALIDATION_PREVIEW');
  assert.equal(calls[2].url.searchParams.get('includedData'), 'identifiers,issues');
  assert.equal(calls[2].url.pathname.split('/').at(-1), 'VALIDATION_INVALID');
  assert.equal(new Headers(calls[2].init?.headers).get('x-amz-access-token'), 'sandbox-access');
});

test('sandbox smoke rejects missing credentials before network access', async () => {
  let called = false;
  await assert.rejects(runAmazonUsSandboxSmoke({ ...credentials, refreshToken: '' }, (async () => {
    called = true;
    return Response.json({});
  }) as typeof fetch), /缺少 Amazon 沙箱应用/);
  assert.equal(called, false);
});

function reviewedAmazonDraft(marketValue = '美国'): ListingDraftPayload {
  const market = requireAmazonMarket(marketValue);
  return {
    mode: 'MOCK', reviewLocale: 'zh-CN',
    schema: { mode: 'MOCK', platformId: 'amazon', platformName: 'Amazon', market: market.label, locale: market.locale, categoryId: 'shirt', categoryLabel: 'T恤', schemaVersion: 'demo', fields: [] },
    fields: { product_type_code: 'SHIRT', seller_sku: 'TEE-PINK-M', brand_name: 'Sample', item_name: '浅粉色短袖', bullet_points: ['第一点', '第二点', '第三点', '第四点', '第五点'], product_description: '棉质短袖', standard_price: 19.99, quantity: 5 },
    fieldSources: {}, confirmedInferredFields: [], source: { passportId: 'p', passportVersion: 1 },
    localization: { status: 'READY', sourceLocale: 'zh-CN', targetLocale: market.locale, targetLanguage: market.language, model: 'test', requestId: null, createdAt: '2026-01-01T00:00:00Z', fields: { item_name: 'Pink cotton shirt', bullet_points: ['One', 'Two', 'Three', 'Four', 'Five'], product_description: 'Cotton shirt' } },
  };
}

test('reviewed listing maps to its selected Amazon store without claiming PTD validation', () => {
  assert.equal(suggestAmazonProductType('女装短袖'), 'SHIRT');
  const request = buildAmazonSandboxListingRequest(reviewedAmazonDraft());
  assert.equal(request.productType, 'SHIRT');
  assert.equal(request.sku, 'TEE-PINK-M');
  assert.equal(request.body.attributes.item_name instanceof Array, true);
  assert.deepEqual(request.body.attributes.item_name, [{ value: 'Pink cotton shirt', marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_US' }]);
  assert.equal((request.body.attributes.bullet_point as unknown[]).length, 5);
  assert.equal(request.body.requirements, 'LISTING');
  assert.throws(() => buildAmazonSandboxListingRequest({ ...reviewedAmazonDraft(), localization: undefined }), /Listing 预览/);
});

test('listing submission sends reviewed body only to the official static sandbox and preserves canned response', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchStub = (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(resource)); calls.push({ url, init });
    if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'sandbox-access' });
    return Response.json({ sku: 'CANNED_SKU', status: 'INVALID', issues: [{ code: '90220' }] });
  }) as typeof fetch;
  const request = buildAmazonSandboxListingRequest(reviewedAmazonDraft());
  const result = await submitAmazonSandboxListing(credentials, request, fetchStub);
  assert.deepEqual(calls.map(({url}) => url.hostname), ['api.amazon.com', 'sandbox.sellingpartnerapi-na.amazon.com']);
  assert.equal(calls[1].url.searchParams.get('mode'), 'VALIDATION_PREVIEW');
  assert.equal(calls[1].url.pathname.split('/').at(-1), 'TEE-PINK-M');
  assert.equal(calls[1].init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), request.body);
  assert.equal(result.response.sandboxSku, 'CANNED_SKU');
  assert.equal(result.response.status, 'INVALID');
  assert.deepEqual(result.response.issueCodes, ['90220']);
});

test('all documented Amazon stores have unique site configuration and route to NA, EU or FE', async () => {
  assert.equal(amazonMarkets.length, 23);
  assert.equal(new Set(amazonMarkets.map((market) => market.marketplaceId)).size, amazonMarkets.length);
  for (const market of amazonMarkets) {
    assert.equal(requireAmazonMarket(market.label).marketplaceId, market.marketplaceId);
    assert.equal(requireAmazonMarket(market.code).marketplaceId, market.marketplaceId);
    const request = buildAmazonSandboxListingRequest(reviewedAmazonDraft(market.code));
    assert.equal(request.marketplaceId, market.marketplaceId);
    assert.equal(request.currency, market.currency);
    assert.equal(request.languageTag, market.locale.replace('-', '_'));
  }
  for (const [code, host] of [['UK', 'eu'], ['JP', 'fe'], ['BR', 'na']]) {
    const calls: URL[] = [];
    const fetchStub = (async (resource: string | URL | Request) => {
      const url = new URL(String(resource)); calls.push(url);
      return Response.json(url.hostname === 'api.amazon.com' ? { access_token: 'sandbox-access' } : { status: 'ACCEPTED', sku: 'CANNED' });
    }) as typeof fetch;
    await submitAmazonSandboxListing(credentials, buildAmazonSandboxListingRequest(reviewedAmazonDraft(code)), fetchStub);
    assert.equal(calls[1].hostname, `sandbox.sellingpartnerapi-${host}.amazon.com`);
    assert.equal(calls[1].searchParams.get('marketplaceIds'), requireAmazonMarket(code).marketplaceId);
  }
});
