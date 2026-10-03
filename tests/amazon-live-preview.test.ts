import assert from 'node:assert/strict';
import test from 'node:test';
import { previewAmazonListingAgainstLiveRules } from '../lib/platforms/amazon-live-preview.ts';
import { requireAmazonMarket } from '../lib/platforms/amazon-markets.ts';
import type { ListingDraftPayload } from '../lib/domain/listing.ts';

const connection = { clientId: 'client', clientSecret: 'secret', refreshToken: 'seller-refresh', sellerId: 'SELLER_123' };

function draft(marketCode: string): ListingDraftPayload {
  const market = requireAmazonMarket(marketCode);
  return {
    mode: 'MOCK', reviewLocale: 'zh-CN',
    schema: { mode: 'MOCK', platformId: 'amazon', platformName: 'Amazon', market: market.label, locale: market.locale, categoryId: 'shirt', categoryLabel: 'T恤', schemaVersion: 'demo', fields: [] },
    fields: { product_type_code: 'SHIRT', seller_sku: 'PINK-TEE', brand_name: 'Sample', item_name: '浅粉色短袖', bullet_points: ['一', '二', '三', '四', '五'], product_description: '短袖', standard_price: 19.99, quantity: 5 },
    fieldSources: {}, confirmedInferredFields: [], source: { passportId: 'p', passportVersion: 1 },
    localization: { status: 'READY', sourceLocale: 'zh-CN', targetLocale: market.locale, targetLanguage: market.language, model: 'test', requestId: null, createdAt: '2026-01-01T00:00:00Z', fields: { item_name: 'Pink tee', bullet_points: ['One', 'Two', 'Three', 'Four', 'Five'], product_description: 'Pink cotton tee' } },
  };
}

test('reads seller-scoped official rules for selected region and sends only validation preview', async () => {
  for (const [marketCode, region] of [['US', 'na'], ['UK', 'eu'], ['JP', 'fe']]) {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchStub = (async (resource: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(resource)); calls.push({ url, init });
      if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'seller-token' });
      if (url.pathname.startsWith('/definitions/')) return Response.json({ productTypeVersion: { version: 'v1' }, schema: { link: { resource: 'https://example.com/ptd.json' }, checksum: 'abc' } });
      if (url.hostname === 'example.com') return Response.json({ properties: { item_name: {}, brand: {}, bullet_point: {}, product_description: {}, purchasable_offer: {}, fulfillment_availability: {} }, required: ['item_name', 'brand', 'manufacturer'] });
      return Response.json({ status: 'INVALID', issues: [{ code: 'ATTRIBUTE_MISSING', message: 'manufacturer required', severity: 'ERROR', attributeNames: ['manufacturer'] }] });
    }) as typeof fetch;
    const result = await previewAmazonListingAgainstLiveRules(connection, draft(marketCode), fetchStub);
    const market = requireAmazonMarket(marketCode);
    assert.equal(calls.length, 4);
    assert.equal(calls[1].url.hostname, `sellingpartnerapi-${region}.amazon.com`);
    assert.equal(calls[1].url.searchParams.get('marketplaceIds'), market.marketplaceId);
    assert.equal(calls[1].url.searchParams.get('sellerId'), connection.sellerId);
    assert.equal(calls[3].url.hostname, `sellingpartnerapi-${region}.amazon.com`);
    assert.equal(calls[3].url.searchParams.get('mode'), 'VALIDATION_PREVIEW');
    assert.equal(calls[3].init?.method, 'PUT');
    assert.equal(new Headers(calls[3].init?.headers).get('x-amz-access-token'), 'seller-token');
    assert.deepEqual(result.missingRequiredAttributes, ['manufacturer']);
    assert.equal(result.preview?.status, 'INVALID');
    assert.equal(result.preview?.issues[0].code, 'ATTRIBUTE_MISSING');
  }
});

test('stops before preview when current mapping contains unsupported attributes', async () => {
  const calls: URL[] = [];
  const fetchStub = (async (resource: string | URL | Request) => {
    const url = new URL(String(resource)); calls.push(url);
    if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'seller-token' });
    if (url.pathname.startsWith('/definitions/')) return Response.json({ schema: { link: { resource: 'https://example.com/ptd.json' } } });
    return Response.json({ properties: { item_name: {} }, required: ['item_name'] });
  }) as typeof fetch;
  const result = await previewAmazonListingAgainstLiveRules(connection, draft('US'), fetchStub);
  assert.equal(calls.length, 3);
  assert.equal(result.preview, null);
  assert.ok(result.unmappedAttributes.includes('brand'));
});
