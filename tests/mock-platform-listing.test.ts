import assert from 'node:assert/strict';
import test from 'node:test';
import { parseListingGenerationOutput } from '../lib/agents/listing-generation.ts';
import { createInitialProductPassport } from '../lib/domain/product-passport.ts';
import { compileMockListingDraft, validateMockListing } from '../lib/mock-platforms/listing-compiler.ts';
import { resolveMockListingSchema } from '../lib/mock-platforms/schemas.ts';

function productPassport() {
  let sequence = 0;
  const passport = createInitialProductPassport({
    taskId: 'task_listing',
    productName: 'BlendGo Mini 便携榨汁杯',
    platforms: ['amazon'],
    markets: ['美国'],
    now: '2026-09-04T00:00:00.000Z',
    idFactory: () => `id-${++sequence}`,
  });
  const brand = passport.facts.find((fact) => fact.key === 'product.brand')!;
  brand.value = 'BlendGo';
  brand.status = 'EXTRACTED';
  brand.confidence = 0.98;
  const category = passport.facts.find((fact) => fact.key === 'product.category_hint')!;
  category.value = '便携榨汁杯';
  category.status = 'EXTRACTED';
  category.confidence = 0.96;
  return passport;
}

test('Amazon Mock Schema separates facts, AI copy and seller inputs', () => {
  const schema = resolveMockListingSchema({ platformId: 'amazon', market: '美国', categoryLabel: '便携榨汁杯' });
  const bullets = schema.fields.find((field) => field.key === 'bullet_points');

  assert.equal(schema.mode, 'MOCK');
  assert.equal(schema.locale, 'en-US');
  assert.equal(bullets?.source, 'AI_GENERATED');
  assert.equal(bullets?.minItems, 5);
  assert.equal(schema.fields.find((field) => field.key === 'brand_name')?.source, 'PRODUCT_FACT');
  assert.equal(schema.fields.find((field) => field.key === 'standard_price')?.source, 'SELLER_INPUT');
});

test('registered long-tail platforms receive a generic Mock Schema', () => {
  const schema = resolveMockListingSchema({ platformId: 'ebay', market: '英国' });
  assert.equal(schema.platformId, 'ebay');
  assert.equal(schema.locale, 'en-GB');
  assert.ok(schema.fields.some((field) => field.key === 'selling_points'));
});

test('Listing Agent parser only accepts AI-owned fields', () => {
  const schema = resolveMockListingSchema({ platformId: 'amazon', market: '美国' });
  const result = parseListingGenerationOutput(JSON.stringify({
    drafts: [{
      draftId: 'draft_amazon',
      fields: {
        item_name: 'Portable Blender for Smoothies',
        bullet_points: ['One', 'Two', 'Three', 'Four', 'Five'],
        brand_name: 'Invented Brand',
        standard_price: 1,
      },
    }],
  }), { productName: 'BlendGo Mini', facts: [], drafts: [{ draftId: 'draft_amazon', schema }] });

  assert.deepEqual(Object.keys(result.drafts[0].fields).sort(), ['bullet_points', 'item_name']);
});

test('compiler maps passport facts and leaves operational fields to the seller', () => {
  const passport = productPassport();
  const draft = passport.platformDrafts[0];
  const schema = resolveMockListingSchema({ platformId: 'amazon', market: '美国', categoryLabel: '便携榨汁杯' });
  const compiled = compileMockListingDraft({
    passport,
    draft,
    schema,
    generatedFields: {
      item_name: 'BlendGo Mini Portable Blender',
      bullet_points: ['Portable', 'Simple', 'Compact', 'Easy to clean', 'For daily drinks'],
      product_description: 'A compact blender for everyday drinks.',
    },
  });

  assert.equal(compiled.payload.fields.brand_name, 'BlendGo');
  assert.equal(compiled.payload.fields.standard_price, undefined);
  assert.ok(compiled.validationIssues.some((issue) => issue.path === 'seller_sku' && issue.code === 'seller_input_required'));
  assert.equal(validateMockListing(schema, compiled.payload.fields).length, compiled.validationIssues.length);
});
