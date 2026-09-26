import assert from 'node:assert/strict';
import test from 'node:test';
import { inferIntakeTargets, inferConversationTargets } from '../lib/agents/intake-targets.ts';

test('infers explicitly named platforms and markets from a chat request', () => {
  const targets = inferIntakeTargets('请把这款商品上新到亚马逊美国站、TikTok 英国站和 Shopee 新加坡站');
  assert.deepEqual(targets.platforms, ['amazon', 'tiktok-shop', 'shopee']);
  assert.deepEqual(targets.markets, ['美国', '英国', '新加坡']);
  assert.equal(targets.platformSource, 'message');
  assert.equal(targets.marketSource, 'message');
});

test('infers newly supported Amazon stores from seller requests', () => {
  assert.deepEqual(inferIntakeTargets('亚马逊加拿大和法国站').markets, ['加拿大', '法国']);
  assert.deepEqual(inferIntakeTargets('Amazon 阿联酋站').markets, ['阿联酋']);
});

test('requires seller selection when the message does not name a platform or market', () => {
  const targets = inferIntakeTargets('这些资料是同一个商品，帮我上新这款产品');
  assert.deepEqual(targets.platforms, []);
  assert.deepEqual(targets.markets, []);
  assert.equal(targets.platformSource, 'missing');
  assert.equal(targets.marketSource, 'missing');
});

 test('conversation retains targets across separate seller replies and ignores assistant and filenames', () => {
  const targets = inferConversationTargets([
    { role: 'assistant', content: 'Amazon 美国' },
    { role: 'user', content: 'Shopify' },
    { role: 'user', content: '日本' },
    { role: 'user', content: '帮我上新\n\n[本轮聊天附件：Amazon美国.xlsx]' },
  ]);
  assert.deepEqual(targets.platforms, ['shopify']);
  assert.deepEqual(targets.markets, ['日本']);
});
 test('later explicit targets replace earlier choices without defaults', () => {
  const targets = inferConversationTargets([
    { role: 'user', content: 'Shopify 日本' },
    { role: 'user', content: '改成美国' },
  ]);
  assert.deepEqual(targets.platforms, ['shopify']);
  assert.deepEqual(targets.markets, ['美国']);
  assert.deepEqual(inferConversationTargets([{ role: 'user', content: '帮我上新' }]).platforms, []);
});

test('questions and rejected targets cannot silently become selections', () => {
  assert.deepEqual(inferConversationTargets([{ role: 'user', content: 'Shopify 美国怎么样？' }]).platforms, []);
  const targets = inferConversationTargets([{ role: 'user', content: 'Shopify 日本' }, { role: 'user', content: '不要日本' }]);
  assert.deepEqual(targets.markets, []);
});
