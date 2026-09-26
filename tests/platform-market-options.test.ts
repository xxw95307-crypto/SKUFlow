import assert from 'node:assert/strict';
import test from 'node:test';
import { marketOptionsForPlatform, targetsFromSharedSelection, validatePlatformTargets } from '../lib/platforms/market-options.ts';

test('the site selector uses each platform’s own market list', () => {
  assert.equal(marketOptionsForPlatform('amazon').length, 23);
  assert.deepEqual(marketOptionsForPlatform('lazada'), ['新加坡', '马来西亚', '泰国', '越南', '菲律宾', '印度尼西亚']);
  assert.ok(marketOptionsForPlatform('shopee').includes('中国台湾'));
  assert.ok(!marketOptionsForPlatform('walmart').includes('日本'));
});

test('seller-selected pairs are normalized and unsupported pairs fail closed', () => {
  assert.deepEqual(validatePlatformTargets([{ platformId: 'amazon', market: 'US' }, { platformId: 'shopee', market: '新加坡' }]), [
    { platformId: 'amazon', market: '美国' }, { platformId: 'shopee', market: '新加坡' },
  ]);
  assert.throws(() => validatePlatformTargets([{ platformId: 'shopee', market: '美国' }]), /暂不支持/);
  assert.throws(() => targetsFromSharedSelection(['amazon', 'shopee'], ['美国', '新加坡']), /分别配对/);
});
