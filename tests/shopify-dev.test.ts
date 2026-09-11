import assert from 'node:assert/strict';
import test from 'node:test';
import type { ListingDraftPayload } from '../lib/domain/listing.ts';
import {
  buildShopifyProductInput,
  getShopifyDevStatus,
  loadShopifyDevConfig,
  publishShopifyDevDraft,
} from '../lib/platforms/shopify-dev.ts';

function listing(): ListingDraftPayload {
  return {
    mode: 'MOCK',
    reviewLocale: 'zh-CN',
    schema: {
      mode: 'MOCK', platformId: 'shopify', platformName: 'Shopify', market: '美国', locale: 'en-US',
      categoryId: 'shirts', categoryLabel: '女士T恤', schemaVersion: 'test-v1', fields: [],
    },
    fields: {
      product_name: '浅粉色圆领短袖T恤',
      title: '浅粉色纯棉圆领短袖T恤',
      body_html: '<p>轻盈舒适的日常基础款。</p>',
      tags: ['纯棉', '短袖'],
      seo_title: '浅粉色纯棉短袖T恤',
      seo_description: '适合日常穿着的浅粉色纯棉圆领短袖T恤。',
      vendor: 'SKUFlow Sample',
      product_type: '女士T恤',
      variant_sku: 'A101-PINK',
      variant_price: 19.9,
      inventory_quantity: 12,
    },
    fieldSources: {}, confirmedInferredFields: [], source: { passportId: 'passport_1', passportVersion: 1 },
  };
}

test('Shopify Dev Store config is explicit and restricted to myshopify.com', () => {
  assert.deepEqual(getShopifyDevStatus({ SHOPIFY_API_VERSION: '2026-07' }).missing, [
    'SHOPIFY_DEV_STORE_DOMAIN', 'SHOPIFY_DEV_CLIENT_ID', 'SHOPIFY_DEV_CLIENT_SECRET',
  ]);
  const config = loadShopifyDevConfig({
    SHOPIFY_DEV_STORE_DOMAIN: 'demo-store',
    SHOPIFY_DEV_CLIENT_ID: 'client',
    SHOPIFY_DEV_CLIENT_SECRET: 'secret',
  });
  assert.equal(config.storeDomain, 'demo-store.myshopify.com');
  assert.throws(() => loadShopifyDevConfig({
    SHOPIFY_DEV_STORE_DOMAIN: 'https://example.com/path',
    SHOPIFY_DEV_CLIENT_ID: 'client',
    SHOPIFY_DEV_CLIENT_SECRET: 'secret',
  }), /myshopify\.com/);
});

test('Shopify product input uses reviewed fields and always creates a DRAFT', () => {
  const product = buildShopifyProductInput(listing(), 'draft_1');
  assert.equal(product.title, '浅粉色纯棉圆领短袖T恤');
  assert.equal(product.status, 'DRAFT');
  assert.deepEqual(product.seo, { title: '浅粉色纯棉短袖T恤', description: '适合日常穿着的浅粉色纯棉圆领短袖T恤。' });
  assert.deepEqual(product.tags, ['纯棉', '短袖', 'skuflow-test', 'skuflow-draft-draft_1']);
});

test('Shopify connector exchanges credentials, creates draft, and updates the initial variant', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/admin/oauth/access_token')) {
      return Response.json({ access_token: 'test-token', expires_in: 86399 });
    }
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    if (body.query.includes('VerifySkuFlowProduct')) {
      const expected = buildShopifyProductInput(listing(), 'draft_1');
      return Response.json({ data: { product: { ...expected, id: 'gid://shopify/Product/123', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/456', price: '19.90', inventoryItem: { sku: 'A101-PINK' } }] } } } });
    }
    if (body.query.includes('CreateSkuFlowProduct')) {
      return Response.json({ data: { productCreate: {
        product: { id: 'gid://shopify/Product/123', title: '测试商品', handle: 'test-product', status: 'DRAFT', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/456' }] } },
        userErrors: [],
      } } });
    }
    return Response.json({ data: { productVariantsBulkUpdate: {
      productVariants: [{ id: 'gid://shopify/ProductVariant/456' }], userErrors: [],
    } } });
  };
  const publication = await publishShopifyDevDraft({
    config: { storeDomain: 'demo-store.myshopify.com', clientId: 'client', clientSecret: 'secret', apiVersion: '2026-07' },
    payload: listing(), draftId: 'draft_1', now: '2026-09-08T00:00:00.000Z',
  }, fetchMock);

  assert.equal(requests.length, 4);
  assert.equal(requests[0]?.url, 'https://demo-store.myshopify.com/admin/oauth/access_token');
  assert.match(String(requests[0]?.init?.body), /grant_type=client_credentials/);
  const createBody = JSON.parse(String(requests[1]?.init?.body)) as { variables: { product: { status: string } } };
  assert.equal(createBody.variables.product.status, 'DRAFT');
  assert.equal(new Headers(requests[1]?.init?.headers).get('X-Shopify-Access-Token'), 'test-token');
  const variantBody = JSON.parse(String(requests[2]?.init?.body)) as { variables: { variants: Array<{ price: string; inventoryItem: { sku: string } }> } };
  assert.equal(variantBody.variables.variants[0]?.price, '19.9');
  assert.equal(variantBody.variables.variants[0]?.inventoryItem.sku, 'A101-PINK');
  assert.ok(publication.verification?.filter((item) => item.status !== 'NOT_SYNCED').every((item) => item.status === 'MATCH'));
  assert.equal(publication.productId, 'gid://shopify/Product/123');
  assert.equal(publication.adminUrl, 'https://demo-store.myshopify.com/admin/products/123');
  assert.match(publication.warnings[0] ?? '', /库存数量暂存/);
});

test('Shopify connector surfaces GraphQL user errors without claiming success', async () => {
  const fetchMock: typeof fetch = async (input) => String(input).endsWith('/admin/oauth/access_token')
    ? Response.json({ access_token: 'test-token' })
    : Response.json({ data: { productCreate: { product: null, userErrors: [{ message: 'Title is invalid' }] } } });
  await assert.rejects(() => publishShopifyDevDraft({
    config: { storeDomain: 'demo-store.myshopify.com', clientId: 'client', clientSecret: 'secret', apiVersion: '2026-07' },
    payload: listing(), draftId: 'draft_1',
  }, fetchMock), /Title is invalid/);
});
