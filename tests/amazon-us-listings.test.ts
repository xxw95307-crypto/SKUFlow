import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exchangeAmazonLwaAccessToken,
  getAmazonUsListing,
  putAmazonUsListing,
  type AmazonUsSellerConnection,
} from '../lib/platforms/amazon-us-listings.ts';

const connection: AmazonUsSellerConnection = {
  clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh', sellerId: 'TEST_SELLER',
};

test('preview and submit use distinct Amazon modes and preserve the reviewed attributes', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchStub = (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(resource));
    calls.push({ url, init });
    if (url.hostname === 'api.amazon.com') return Response.json({ access_token: 'test-access' });
    return Response.json({ sku: 'PINK-M', status: 'ACCEPTED', submissionId: 'submission-1', issues: [] });
  }) as typeof fetch;
  const item = { sku: 'PINK-M', productType: 'SHIRT', attributes: { item_name: [{ value: 'Pink cotton shirt' }] } };
  await putAmazonUsListing(connection, item, 'PREVIEW', fetchStub);
  await putAmazonUsListing(connection, item, 'SUBMIT', fetchStub);

  const listingCalls = calls.filter((call) => call.url.hostname === 'sellingpartnerapi-na.amazon.com');
  assert.equal(listingCalls.length, 2);
  assert.equal(listingCalls[0].url.searchParams.get('mode'), 'VALIDATION_PREVIEW');
  assert.equal(listingCalls[1].url.searchParams.has('mode'), false);
  for (const call of listingCalls) {
    assert.equal(call.url.searchParams.get('marketplaceIds'), 'ATVPDKIKX0DER');
    assert.equal(new Headers(call.init?.headers).get('x-amz-access-token'), 'test-access');
    assert.match(new Headers(call.init?.headers).get('x-amz-date') ?? '', /^\d{8}T\d{6}Z$/);
    assert.match(new Headers(call.init?.headers).get('user-agent') ?? '', /^SKUFlowAI\//);
    assert.deepEqual(JSON.parse(String(call.init?.body)), { productType: 'SHIRT', requirements: 'LISTING', attributes: item.attributes });
  }
});

test('missing seller authorization fails before any network request', async () => {
  let called = false;
  const fetchStub = (async () => { called = true; return Response.json({}); }) as typeof fetch;
  await assert.rejects(
    exchangeAmazonLwaAccessToken({ ...connection, refreshToken: '' }, fetchStub),
    /尚未连接/,
  );
  assert.equal(called, false);
});

test('readback requests listing status and issues', async () => {
  const urls: URL[] = [];
  const fetchStub = (async (resource: string | URL | Request) => {
    const url = new URL(String(resource));
    urls.push(url);
    return Response.json(url.hostname === 'api.amazon.com' ? { access_token: 'token' } : { sku: 'PINK-M', issues: [] });
  }) as typeof fetch;
  const item = await getAmazonUsListing(connection, 'PINK-M', fetchStub);
  assert.equal(item.sku, 'PINK-M');
  assert.equal(urls[1].searchParams.get('includedData'), 'summaries,attributes,issues,offers,fulfillmentAvailability');
});
