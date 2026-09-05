import assert from 'node:assert/strict';
import test from 'node:test';
import { inferIntakeTargets } from '../lib/agents/intake-targets.ts';

test('infers explicitly named platforms and markets from a chat request', () => {
  const targets = inferIntakeTargets('请把这款商品上新到亚马逊美国站、TikTok 英国站和 Shopee 新加坡站');
  assert.deepEqual(targets.platforms, ['amazon', 'tiktok-shop', 'shopee']);
  assert.deepEqual(targets.markets, ['美国', '英国', '新加坡']);
  assert.equal(targets.platformSource, 'message');
  assert.equal(targets.marketSource, 'message');
});

test('uses the MVP defaults when the first message only asks to list the product', () => {
  const targets = inferIntakeTargets('这些资料是同一个商品，帮我上新这款产品');
  assert.deepEqual(targets.platforms, ['amazon', 'tiktok-shop', 'shopify', 'shopee']);
  assert.deepEqual(targets.markets, ['美国']);
  assert.equal(targets.platformSource, 'default');
  assert.equal(targets.marketSource, 'default');
});
