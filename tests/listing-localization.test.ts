import assert from 'node:assert/strict';
import test from 'node:test';
import { buildListingLocalizationMessages, hasCompleteListingLocalization, localizedPublicationPayload, parseListingLocalizationOutput, translatableListingFields } from '../lib/agents/listing-localization.ts';
import { marketLocale } from '../lib/localization/market-locales.ts';
import { callBailianListingLocalization } from '../lib/ai/bailian-client.ts';
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
  assert.equal(marketLocale('加拿大').locale, 'en-CA');
  assert.equal(marketLocale('法国').locale, 'fr-FR');
  assert.equal(marketLocale('泰国').locale, 'th-TH');
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

test('mock delivery localizes buyer-facing facts while preserving seller values and brand names', () => {
  const mockPayload: ListingDraftPayload = {
    ...payload,
    mode: 'MOCK',
    schema: { ...payload.schema, mode: 'MOCK', platformId: 'tiktok-shop', fields: [
      { key: 'product_name', label: '商品名称', type: 'string', source: 'PRODUCT_FACT', required: true, maxLength: 120 },
      { key: 'material', label: '材质', type: 'string', source: 'PRODUCT_FACT', required: false },
      { key: 'color', label: '颜色', type: 'string', source: 'PRODUCT_FACT', required: false },
      { key: 'brand', label: '品牌', type: 'string', source: 'PRODUCT_FACT', required: true },
      { key: 'seller_sku', label: 'SKU', type: 'string', source: 'SELLER_INPUT', required: true },
      { key: 'price', label: '售价', type: 'number', source: 'SELLER_INPUT', required: true },
    ] },
    fields: { product_name: '浅驼色针织开衫', material: '羊毛混纺', color: '浅驼色', brand: 'Acme', seller_sku: 'A101', price: 49.9 },
  };
  assert.deepEqual(translatableListingFields(mockPayload).map((field) => field.key), ['product_name', 'material', 'color']);
  const oldLocalization = { status: 'READY' as const, sourceLocale: 'zh-CN' as const, targetLocale: 'en-US', targetLanguage: '英语', fields: { product_name: 'Light camel cardigan' }, model: 'test', requestId: null, createdAt: 'now' };
  assert.equal(hasCompleteListingLocalization({ ...mockPayload, localization: oldLocalization }, 'en-US'), false);
  const fields = parseListingLocalizationOutput(JSON.stringify({ fields: { product_name: 'Light camel knit cardigan', material: 'Wool blend', color: 'Light camel' } }), { payload: mockPayload, targetLocale: 'en-US', targetLanguage: '英语' });
  const localized = localizedPublicationPayload({ ...mockPayload, localization: { ...oldLocalization, fields } });
  assert.equal(hasCompleteListingLocalization(localized, 'en-US'), true);
  assert.equal(localized.fields.material, 'Wool blend');
  assert.equal(localized.fields.color, 'Light camel');
  assert.equal(localized.fields.brand, 'Acme');
  assert.equal(localized.fields.seller_sku, 'A101');
  assert.equal(localized.fields.price, 49.9);
  assert.deepEqual(translatableListingFields({ ...mockPayload, fields: { ...mockPayload.fields, brand: '无品牌' } }).map((field) => field.key), ['product_name', 'material', 'color', 'brand']);
});

test('overlong localized video copy is rewritten before delivery', async () => {
  const videoPayload: ListingDraftPayload = {
    ...payload,
    mode: 'MOCK',
    schema: { ...payload.schema, mode: 'MOCK', platformId: 'tiktok-shop', fields: [
      { key: 'video_hook', label: '短视频开场文案', type: 'string', source: 'AI_GENERATED', required: false, maxLength: 150 },
    ] },
    fields: { video_hook: '浅粉色披肩蝴蝶结针织开衫，适合秋冬穿搭。' },
  };
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const video_hook = requests.length === 1 ? 'A'.repeat(170) : 'A soft pink knit cardigan with a bow for autumn outfits.';
    return Response.json({ id: `request-${requests.length}`, model: 'test', choices: [{ message: { content: JSON.stringify({ fields: { video_hook } }) } }] });
  };
  const result = await callBailianListingLocalization(
    { apiKey: 'test', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'test' },
    { payload: videoPayload, targetLocale: 'en-US', targetLanguage: '英语' },
    fetcher as typeof fetch,
  );
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1)?.content ?? '', /超过 150 字符上限/);
  assert.equal(result.fields.video_hook, 'A soft pink knit cardigan with a bow for autumn outfits.');
});
