import assert from 'node:assert/strict';
import test from 'node:test';
import { buildListingLocalizationMessages, localizedPublicationPayload, parseListingLocalizationOutput } from '../lib/agents/listing-localization.ts';
import { marketLocale } from '../lib/localization/market-locales.ts';
import type { ListingDraftPayload } from '../lib/domain/listing.ts';

const payload: ListingDraftPayload = {
  mode: 'SHOPIFY_API', reviewLocale: 'zh-CN',
  schema: { mode: 'SHOPIFY_API', platformId: 'shopify', platformName: 'Shopify', market: '日本', locale: 'ja-JP', categoryId: 'product', categoryLabel: '女式T恤', schemaVersion: 'test', fields: [
    { key: 'title', label: '商品标题', type: 'string', source: 'AI_GENERATED', required: true, maxLength: 255 },
    { key: 'body_html', label: '商品描述', type: 'text', source: 'AI_GENERATED', required: true, maxLength: 5000 },
    { key: 'tags', label: '标签', type: 'string_array', source: 'AI_GENERATED', required: false, maxItems: 12, itemMaxLength: 60 },
    { key: 'variant_sku', label: 'SKU', type: 'string', source: 'SELLER_INPUT', required: true },
    { key: 'variant_price', label: '售价', type: 'number', source: 'SELLER_INPUT', required: true },
  ] },
  fields: { title: '浅粉色纯棉圆领短袖T恤', body_html: '采用100%纯棉面料。', tags: ['女式T恤', '纯棉'], variant_sku: 'A101-PINK', variant_price: 99 },
  fieldSources: { title: 'AI_GENERATED', body_html: 'AI_GENERATED', tags: 'AI_GENERATED', variant_sku: 'SELLER_INPUT', variant_price: 'SELLER_INPUT' },
  confirmedInferredFields: [], source: { passportId: 'p1', passportVersion: 1 },
};

test('market determines the real publication locale', () => {
  assert.deepEqual(marketLocale('日本'), { locale: 'ja-JP', language: '日语' });
  assert.equal(marketLocale('德国').locale, 'de-DE');
  assert.equal(marketLocale('未知市场').locale, 'en-US');
});

test('localization only accepts translatable copy and preserves seller fields at publication', () => {
  const context = { payload, targetLocale: 'ja-JP', targetLanguage: '日语' };
  const messages = buildListingLocalizationMessages(context);
  assert.ok(messages[0].content.includes('不得增加商品事实'));
  assert.ok(!messages[1].content.includes('A101-PINK'));
  const fields = parseListingLocalizationOutput(JSON.stringify({ fields: { title: 'ライトピンク純綿クルーネック半袖Tシャツ', body_html: '綿100％の生地を使用。', tags: ['レディースTシャツ', '純綿'] } }), context);
  const localized = localizedPublicationPayload({ ...payload, localization: { status: 'READY', sourceLocale: 'zh-CN', targetLocale: 'ja-JP', targetLanguage: '日语', fields, model: 'qwen', requestId: 'r1', createdAt: 'now' } });
  assert.equal(localized.fields.title, 'ライトピンク純綿クルーネック半袖Tシャツ');
  assert.equal(localized.fields.variant_sku, 'A101-PINK');
  assert.equal(localized.fields.variant_price, 99);
});

test('localization rejects extra fields and changed list structure', () => {
  const context = { payload, targetLocale: 'ja-JP', targetLanguage: '日语' };
  assert.throws(() => parseListingLocalizationOutput(JSON.stringify({ fields: { title: '商品', body_html: '説明', tags: ['一つ'], variant_sku: '改ざん' } }), context), /未授权字段/);
  assert.throws(() => parseListingLocalizationOutput(JSON.stringify({ fields: { title: '商品', body_html: '説明', tags: ['一つ'] } }), context), /条目数发生变化/);
});
