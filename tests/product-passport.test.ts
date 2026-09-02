import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialProductPassport, isFactStatus } from '../lib/domain/product-passport.ts';

test('creates one traceable fact foundation and one draft per platform-market pair', () => {
  let sequence = 0;
  const passport = createInitialProductPassport({
    taskId: 'task_demo',
    productName: 'BlendGo Mini',
    platforms: ['amazon', 'shopify'],
    markets: ['美国', '英国'],
    now: '2026-09-02T00:00:00.000Z',
    idFactory: () => `id-${++sequence}`,
  });

  assert.equal(passport.version, 1);
  assert.equal(passport.status, 'OPEN');
  assert.equal(passport.facts.length, 3);
  assert.equal(passport.evidence.length, 1);
  assert.equal(passport.platformDrafts.length, 4);
  assert.deepEqual(
    passport.platformDrafts.map((draft) => `${draft.platformId}:${draft.market}`),
    ['amazon:美国', 'amazon:英国', 'shopify:美国', 'shopify:英国'],
  );

  const name = passport.facts.find((fact) => fact.key === 'product.name');
  assert.equal(name?.value, 'BlendGo Mini');
  assert.equal(name?.status, 'CONFIRMED');
  assert.deepEqual(name?.evidenceIds, [passport.evidence[0].id]);
  assert.equal(passport.facts.find((fact) => fact.key === 'product.brand')?.status, 'MISSING');
});

test('recognizes only supported fact states', () => {
  assert.equal(isFactStatus('CONFLICT'), true);
  assert.equal(isFactStatus('READY'), false);
});
