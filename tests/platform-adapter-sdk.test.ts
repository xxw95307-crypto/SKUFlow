import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialProductPassport } from '../lib/domain/product-passport.ts';
import { platformRegistry } from '../lib/platforms/registry.ts';
import { PlatformAdapterRegistry } from '../lib/platform-sdk/adapter-registry.ts';
import { coreProductAdapter } from '../lib/platform-sdk/adapters/core-product-adapter.ts';
import { compileWithRules } from '../lib/platform-sdk/compiler.ts';
import { coreProductRules, definePlatformRules } from '../lib/platform-sdk/rule-config.ts';

function createPassport() {
  let sequence = 0;
  return createInitialProductPassport({
    taskId: 'task_adapter',
    productName: '  BlendGo Mini  ',
    platforms: ['amazon'],
    markets: ['US'],
    now: '2026-09-03T00:00:00.000Z',
    idFactory: () => `adapter-${++sequence}`,
  });
}

test('validates the versioned rule configuration format', () => {
  assert.equal(coreProductRules.schemaVersion, '1.0');
  assert.equal(coreProductRules.fields.length, 8);
  assert.throws(() => definePlatformRules({
    schemaVersion: '1.0',
    id: 'duplicate-target',
    version: '1.0.0',
    title: 'Invalid rules',
    fields: [
      { sourceFact: 'product.name', targetPath: 'product.title', label: 'Title' },
      { sourceFact: 'product.brand', targetPath: 'product.title', label: 'Brand' },
    ],
  }), /目标字段重复/);
});

test('compiles usable passport facts and reports required missing facts', () => {
  const passport = createPassport();
  const draft = passport.platformDrafts[0];
  const result = compileWithRules({
    passport,
    draft,
    platform: platformRegistry.find((platform) => platform.id === 'amazon')!,
  }, coreProductRules);

  const data = result.payload.data as { product: { title: string } };
  assert.equal(data.product.title, 'BlendGo Mini');
  assert.equal(result.mappedFields, 1);
  assert.equal(result.skippedFields, 7);
  assert.deepEqual(
    result.validationIssues.filter((issue) => issue.code === 'required_fact_missing').map((issue) => issue.path),
    ['product.brand', 'product.categoryHint'],
  );
  assert.equal(result.schemaVersion, 'core-product@1.0.0');
});

test('registry covers every declared platform with the fallback adapter', () => {
  const registry = new PlatformAdapterRegistry().register(coreProductAdapter);
  assert.equal(Object.keys(registry.coverage()).length, platformRegistry.length);
  for (const platform of platformRegistry) {
    assert.equal(registry.resolve(platform.id).id, 'core-product-adapter');
  }
  assert.throws(() => registry.register(coreProductAdapter), /已注册/);
});

test('registry lets a higher-priority platform adapter replace the fallback', () => {
  const amazonAdapter = {
    ...coreProductAdapter,
    id: 'amazon-adapter',
    name: 'Amazon Adapter',
    kind: 'platform' as const,
    priority: 100,
    supports: ['amazon'] as const,
  };
  const registry = new PlatformAdapterRegistry()
    .register(coreProductAdapter)
    .register(amazonAdapter);

  assert.equal(registry.resolve('amazon').id, 'amazon-adapter');
  assert.equal(registry.resolve('shopify').id, 'core-product-adapter');
});
