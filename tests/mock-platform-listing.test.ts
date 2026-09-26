import assert from 'node:assert/strict';
import test from 'node:test';
import { buildListingGenerationMessages, parseListingGenerationOutput } from '../lib/agents/listing-generation.ts';
import { createInitialProductPassport } from '../lib/domain/product-passport.ts';
import { compileMockListingDraft, validateMockListing } from '../lib/mock-platforms/listing-compiler.ts';
import { resolveMockListingSchema } from '../lib/mock-platforms/schemas.ts';

function productPassport() {
  let sequence = 0;
  const passport = createInitialProductPassport({
    taskId: 'task_listing',
    platforms: ['amazon'],
    markets: ['美国'],
    now: '2026-09-04T00:00:00.000Z',
    idFactory: () => `id-${++sequence}`,
  });
  passport.facts.push(
    {
      id: 'fact_name', key: 'product.name', label: '商品名称', value: 'BlendGo Mini 便携榨汁杯', unit: null,
      status: 'EXTRACTED', sourceKind: 'VISION', confidence: 0.99, evidenceIds: [],
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    },
    {
      id: 'fact_brand', key: 'product.brand', label: '品牌', value: 'BlendGo', unit: null,
      status: 'EXTRACTED', sourceKind: 'FILE_TEXT', confidence: 0.98, evidenceIds: [],
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    },
    {
      id: 'fact_category', key: 'product.category_hint', label: '候选类目', value: '便携榨汁杯', unit: null,
      status: 'EXTRACTED', sourceKind: 'FILE_TEXT', confidence: 0.96, evidenceIds: [],
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    },
  );
  return passport;
}

test('Amazon Mock Schema separates facts, AI copy and seller inputs', () => {
  const schema = resolveMockListingSchema({ platformId: 'amazon', market: '美国', categoryLabel: '便携榨汁杯' });
  const bullets = schema.fields.find((field) => field.key === 'bullet_points');

  assert.equal(schema.mode, 'MOCK');
  assert.equal(schema.locale, 'en-US');
  assert.equal(schema.fields.find((field) => field.key === 'product_name')?.factKey, 'product.name');
  assert.equal(bullets?.source, 'AI_GENERATED');
  assert.equal(bullets?.minItems, 5);
  assert.equal(schema.fields.find((field) => field.key === 'brand_name')?.source, 'PRODUCT_FACT');
  assert.equal(schema.fields.find((field) => field.key === 'standard_price')?.source, 'SELLER_INPUT');
});

test('Amazon draft shows the selected store currency and locale', () => {
  for (const [market, locale, currency] of [['英国', 'en-GB', 'GBP'], ['日本', 'ja-JP', 'JPY'], ['巴西', 'pt-BR', 'BRL']]) {
    const schema = resolveMockListingSchema({ platformId: 'amazon', market });
    assert.equal(schema.locale, locale);
    assert.equal(schema.fields.find((field) => field.key === 'standard_price')?.unit, currency);
  }
});

test('registered long-tail platforms receive a generic Mock Schema', () => {
  const schema = resolveMockListingSchema({ platformId: 'ebay', market: '英国' });
  assert.equal(schema.platformId, 'ebay');
  assert.equal(schema.locale, 'en-GB');
  assert.ok(schema.fields.some((field) => field.key === 'selling_points'));
});

test('Listing Agent parser accepts copy and inferred platform facts, but rejects seller inputs', () => {
  const schema = resolveMockListingSchema({ platformId: 'amazon', market: '美国' });
  const result = parseListingGenerationOutput(JSON.stringify({
    drafts: [{
      draftId: 'draft_amazon',
      fields: {
        item_name: 'Portable Blender for Smoothies',
        bullet_points: ['One', 'Two', 'Three', 'Four', 'Five'],
        color_name: 'Pink',
        brand_name: 'Invented Brand',
        standard_price: 1,
      },
    }],
  }), { productName: 'BlendGo Mini', facts: [], drafts: [{ draftId: 'draft_amazon', schema }] });

  assert.deepEqual(Object.keys(result.drafts[0].fields).sort(), ['brand_name', 'bullet_points', 'color_name', 'item_name']);
});

test('Listing Agent generates a Chinese review draft while preserving the target locale', () => {
  const schema = resolveMockListingSchema({ platformId: 'amazon', market: '美国', categoryLabel: '便携榨汁杯' });
  const messages = buildListingGenerationMessages({
    productName: 'BlendGo Mini 便携榨汁杯',
    facts: productPassport().facts,
    drafts: [{ draftId: 'draft_amazon', schema }],
  });
  const target = JSON.parse(messages[1].content) as { targets: Array<{ reviewLocale: string; targetLocale: string }> };

  assert.match(messages[0].content, /所有标题、卖点、描述、标签和搜索词.*简体中文/);
  assert.equal(target.targets[0].reviewLocale, 'zh-CN');
  assert.equal(target.targets[0].targetLocale, 'en-US');
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
  assert.equal(compiled.payload.reviewLocale, 'zh-CN');
  assert.equal(compiled.payload.fieldSources.brand_name, 'PRODUCT_FACT');
  assert.equal(compiled.payload.fields.standard_price, undefined);
  assert.ok(compiled.validationIssues.some((issue) => issue.path === 'seller_sku' && issue.code === 'seller_input_required'));
  assert.equal(validateMockListing(
    schema,
    compiled.payload.fields,
    compiled.payload.fieldSources,
    compiled.payload.confirmedInferredFields,
  ).length, compiled.validationIssues.length);
});

test('AI-inferred platform fields are editable but require seller confirmation', () => {
  const passport = productPassport();
  const schema = resolveMockListingSchema({ platformId: 'amazon', market: '美国', categoryLabel: '便携榨汁杯' });
  const compiled = compileMockListingDraft({
    passport,
    draft: passport.platformDrafts[0],
    schema,
    generatedFields: {
      item_name: 'BlendGo Mini Portable Blender',
      bullet_points: ['Portable', 'Simple', 'Compact', 'Easy to clean', 'For daily drinks'],
      product_description: 'A compact blender for everyday drinks.',
      color_name: 'Pink',
    },
  });

  assert.equal(compiled.payload.fieldSources.color_name, 'AI_INFERRED');
  assert.ok(compiled.validationIssues.some((issue) => issue.path === 'color_name' && issue.code === 'ai_inference_confirmation_required'));
  const afterConfirmation = validateMockListing(schema, compiled.payload.fields, compiled.payload.fieldSources, ['color_name']);
  assert.equal(afterConfirmation.some((issue) => issue.path === 'color_name' && issue.code === 'ai_inference_confirmation_required'), false);
});
