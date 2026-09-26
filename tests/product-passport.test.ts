import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialProductPassport, isFactStatus } from '../lib/domain/product-passport.ts';

test('creates an empty open fact collection and one draft per platform-market pair', () => {
  let sequence = 0;
  const passport = createInitialProductPassport({
    taskId: 'task_demo',
    platforms: ['amazon', 'shopify'],
    markets: ['美国', '英国'],
    now: '2026-09-02T00:00:00.000Z',
    idFactory: () => `id-${++sequence}`,
  });

  assert.equal(passport.version, 1);
  assert.equal(passport.status, 'OPEN');
  assert.equal(passport.facts.length, 0);
  assert.equal(passport.evidence.length, 0);
  assert.equal(passport.platformDrafts.length, 4);
  assert.deepEqual(
    passport.platformDrafts.map((draft) => `${draft.platformId}:${draft.market}`),
    ['amazon:美国', 'amazon:英国', 'shopify:美国', 'shopify:英国'],
  );

});

test('recognizes only supported fact states', () => {
  assert.equal(isFactStatus('CONFLICT'), true);
  assert.equal(isFactStatus('READY'), false);
});

test('explicit platform targets create only seller-selected drafts', () => {
  let sequence = 0;
  const passport = createInitialProductPassport({
    taskId: 'task_selected', platforms: ['amazon', 'shopee'], markets: ['美国', '新加坡'],
    targets: [{ platformId: 'amazon', market: '美国' }, { platformId: 'shopee', market: '新加坡' }],
    now: '2026-09-26T00:00:00.000Z', idFactory: () => `id-${++sequence}`,
  });
  assert.deepEqual(passport.platformDrafts.map((draft) => `${draft.platformId}:${draft.market}`), ['amazon:美国', 'shopee:新加坡']);
});
