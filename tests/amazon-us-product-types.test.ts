import assert from 'node:assert/strict';
import test from 'node:test';
import { AMAZON_US_MARKETPLACE_ID, fetchAmazonUsProductTypeDefinition } from '../lib/platforms/amazon-us-product-types.ts';

test('requests the seller-scoped US product type schema and downloads its temporary document', async () => {
  const requests: Array<{ url: URL; token: string | null }> = [];
  const fetchStub = (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(resource));
    requests.push({ url, token: new Headers(init?.headers).get('x-amz-access-token') });
    if (requests.length === 1) return Response.json({
      productType: 'SHIRT',
      productTypeVersion: { version: '2026-09-01' },
      schema: { link: { resource: 'https://example.com/schema.json' }, checksum: 'checksum' },
    });
    return Response.json({ type: 'object', properties: { item_name: { type: 'array' } } });
  }) as typeof fetch;

  const result = await fetchAmazonUsProductTypeDefinition({
    accessToken: 'test-access-token', productType: 'shirt', sellerId: 'TEST_SELLER', parentageLevel: 'CHILD',
  }, fetchStub);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.hostname, 'sellingpartnerapi-na.amazon.com');
  assert.equal(requests[0].url.searchParams.get('marketplaceIds'), AMAZON_US_MARKETPLACE_ID);
  assert.equal(requests[0].url.searchParams.get('requirements'), 'LISTING');
  assert.equal(requests[0].url.searchParams.get('locale'), 'en_US');
  assert.equal(requests[0].url.searchParams.get('parentageLevel'), 'CHILD');
  assert.equal(requests[0].url.searchParams.get('sellerId'), 'TEST_SELLER');
  assert.equal(requests[0].token, 'test-access-token');
  assert.equal(requests[1].token, null);
  assert.equal(result.version, '2026-09-01');
  assert.equal(result.marketplaceId, AMAZON_US_MARKETPLACE_ID);
  assert.ok(result.schema.properties);
});

test('fails closed when the official schema cannot be fetched', async () => {
  const fetchStub = (async () => Response.json({ message: 'Forbidden' }, { status: 403 })) as typeof fetch;
  await assert.rejects(
    fetchAmazonUsProductTypeDefinition({ accessToken: 'token', productType: 'SHIRT', parentageLevel: 'NONE' }, fetchStub),
    /HTTP 403/,
  );
});
