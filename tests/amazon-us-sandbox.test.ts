import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAmazonUsSandboxListingRequest, runAmazonUsSandboxSmoke, submitAmazonUsSandboxListing, suggestAmazonUsProductType } from '../lib/platforms/amazon-us-sandbox.ts';
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

function reviewedAmazonDraft(): ListingDraftPayload {
  return {
    mode: 'MOCK', reviewLocale: 'zh-CN',
    schema: { mode: 'MOCK', platformId: 'amazon', platformName: 'Amazon', market: '美国', locale: 'en_US', categoryId: 'shirt', categoryLabel: 'T恤', schemaVersion: 'demo', fields: [] },
    fields: { product_type_code: 'SHIRT', seller_sku: 'TEE-PINK-M', brand_name: 'Sample', item_name: '浅粉色短袖', bullet_points: ['第一点', '第二点', '第三点', '第四点', '第五点'], product_description: '棉质短袖', standard_price: 19.99, quantity: 5 },
    fieldSources: {}, confirmedInferredFields: [], source: { passportId: 'p', passportVersion: 1 },
    localization: { status: 'READY', sourceLocale: 'zh-CN', targetLocale: 'en-US', targetLanguage: 'English', model: 'test', requestId: null, createdAt: '2026-01-01T00:00:00Z', fields: { item_name: 'Pink cotton shirt', bullet_points: ['One', 'Two', 'Three', 'Four', 'Five'], product_description: 'Cotton shirt' } },
  };
}

test('reviewed English listing maps to Amazon US sandbox request without claiming PTD validation', () => {
  assert.equal(suggestAmazonUsProductType('女装短袖'), 'SHIRT');
  const request = buildAmazonUsSandboxListingRequest(reviewedAmazonDraft());
  assert.equal(request.productType, 'SHIRT');
  assert.equal(request.sku, 'TEE-PINK-M');
  assert.equal(request.body.attributes.item_name instanceof Array, true);
  assert.deepEqual(request.body.attributes.item_name, [{ value: 'Pink cotton shirt', marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_US' }]);
  assert.equal((request.body.attributes.bullet_point as unknown[]).length, 5);
  assert.equal(request.body.requirements, 'LISTING');
  assert.throws(() => buildAmazonUsSandboxListingRequest({ ...reviewedAmazonDraft(), localization: undefined }), /英文 Listing/);
});

test('listing submission sends reviewed body only to the official static sandbox and preserves canned response', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchStub = (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(resource)); calls.push({ url, init });
    if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'sandbox-access' });
    return Response.json({ sku: 'CANNED_SKU', status: 'INVALID', issues: [{ code: '90220' }] });
  }) as typeof fetch;
  const request = buildAmazonUsSandboxListingRequest(reviewedAmazonDraft());
  const result = await submitAmazonUsSandboxListing(credentials, request, fetchStub);
  assert.deepEqual(calls.map(({url}) => url.hostname), ['api.amazon.com', 'sandbox.sellingpartnerapi-na.amazon.com']);
  assert.equal(calls[1].url.searchParams.get('mode'), 'VALIDATION_PREVIEW');
  assert.equal(calls[1].url.pathname.split('/').at(-1), 'TEE-PINK-M');
  assert.equal(calls[1].init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), request.body);
  assert.equal(result.response.sandboxSku, 'CANNED_SKU');
  assert.equal(result.response.status, 'INVALID');
  assert.deepEqual(result.response.issueCodes, ['90220']);
});
