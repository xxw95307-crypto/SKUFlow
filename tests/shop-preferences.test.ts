import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShopPreferences } from '../lib/domain/shop-preferences.ts';
import { buildListingGenerationMessages, parseListingGenerationOutput } from '../lib/agents/listing-generation.ts';
import { buildAssetPlanningMessages } from '../lib/agents/asset-generation.ts';
import { resolveMockListingSchema } from '../lib/mock-platforms/schemas.ts';

const preferences = parseShopPreferences({
  brandVoice: '简洁亲切，避免夸大',
  bannedWords: ['绝对', '最便宜', '绝对'],
  preferredTargets: [{ platformId: 'amazon', market: '美国' }, { platformId: 'shopify', market: '英国' }],
  visualStyle: '柔和自然光、米白背景',
}, '2026-10-07T00:00:00.000Z');

test('confirmed shop preferences deduplicate terms and validate exact platform-market pairs', () => {
  assert.deepEqual(preferences.bannedWords, ['绝对', '最便宜']);
  assert.equal(preferences.preferredTargets.length, 2);
  assert.throws(() => parseShopPreferences({ ...preferences, preferredTargets: [{ platformId: 'shopify', market: '火星' }] }), /暂不支持/);
});

test('listing generation applies brand voice and removes banned words only from generated copy', () => {
  const schema = resolveMockListingSchema({ platformId: 'amazon', market: '美国' });
  const context = { productName: '棉质T恤', facts: [], drafts: [{ draftId: 'draft_a', schema }], preferences };
  const messages = buildListingGenerationMessages(context);
  assert.match(messages[1].content, /简洁亲切/);
  assert.match(messages[0].content, /不是商品事实或证据/);
  const output = parseListingGenerationOutput(JSON.stringify({ drafts: [{ draftId: 'draft_a', fields: {
    item_name: '绝对舒适棉质T恤',
    color_name: '绝对粉色',
  } }] }), context).drafts[0].fields;
  assert.equal(output.item_name, '舒适棉质T恤');
  assert.equal(output.color_name, '绝对粉色');
});

test('visual planning uses saved style as a default while keeping this request first', () => {
  const messages = buildAssetPlanningMessages({
    productName: '棉质T恤', facts: [], listings: [], platforms: ['amazon'], markets: ['美国'],
    sourceImageCount: 1, userGuidance: '这次用黑色背景', preferences,
  });
  assert.match(messages[0].content, /本轮明确提出的要求覆盖旧图的风格和早先的店铺偏好/);
  assert.match(messages[1].content, /柔和自然光、米白背景/);
  assert.match(messages[1].content, /这次用黑色背景/);
});
