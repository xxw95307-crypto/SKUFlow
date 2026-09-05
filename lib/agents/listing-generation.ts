import type { ListingFieldDefinition, ListingGenerationOutput, MockListingSchema } from '../domain/listing';
import type { ProductFact } from '../domain/product-passport';

export const LISTING_GENERATION_PROMPT_VERSION = 'listing-mock-v3-zh-review';

export interface ListingGenerationContext {
  productName: string;
  facts: ProductFact[];
  drafts: Array<{ draftId: string; schema: MockListingSchema }>;
}

function unwrapJson(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  return JSON.parse(unfenced);
}

function normalizeGeneratedValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().slice(0, 8_000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map((item) => item.trim().slice(0, 1_000)).filter(Boolean).slice(0, 20);
  }
  return undefined;
}

function usableFact(fact: ProductFact | undefined): boolean {
  return Boolean(fact && fact.value !== null && fact.status !== 'MISSING' && fact.status !== 'CONFLICT');
}

function generationFields(schema: MockListingSchema, facts: ProductFact[]): ListingFieldDefinition[] {
  const factByKey = new Map(facts.map((fact) => [fact.key, fact]));
  return schema.fields.filter((field) => (
    field.source === 'AI_GENERATED'
    || (field.source === 'PRODUCT_FACT' && field.allowAiInference === true && !usableFact(field.factKey ? factByKey.get(field.factKey) : undefined))
  ));
}

export function parseListingGenerationOutput(content: string, context: ListingGenerationContext): ListingGenerationOutput {
  const parsed = unwrapJson(content);
  if (!parsed || typeof parsed !== 'object') throw new Error('Listing Agent 未返回 JSON 对象');
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.drafts)) throw new Error('Listing Agent 结果缺少 drafts 数组');
  const allowedByDraft = new Map(context.drafts.map(({ draftId, schema }) => [
    draftId,
    new Set(generationFields(schema, context.facts).map((field) => field.key)),
  ]));
  const drafts = [];
  for (const item of root.drafts.slice(0, context.drafts.length)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const draftId = typeof record.draftId === 'string' ? record.draftId : '';
    const allowed = allowedByDraft.get(draftId);
    if (!allowed || !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) continue;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record.fields as Record<string, unknown>)) {
      if (!allowed.has(key)) continue;
      const normalized = normalizeGeneratedValue(value);
      if (normalized !== undefined) fields[key] = normalized;
    }
    drafts.push({ draftId, fields });
  }
  return {
    drafts,
    notes: Array.isArray(root.notes)
      ? root.notes.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 300)).slice(0, 10)
      : [],
  };
}

export function buildListingGenerationMessages(context: ListingGenerationContext): Array<{ role: 'system' | 'user'; content: string }> {
  const facts = context.facts
    .filter((fact) => fact.value !== null && fact.status !== 'MISSING' && fact.status !== 'CONFLICT')
    .map((fact) => ({ key: fact.key, label: fact.label, value: fact.value, unit: fact.unit }));
  const targets = context.drafts.map(({ draftId, schema }) => ({
    draftId,
    platform: schema.platformName,
    market: schema.market,
    reviewLocale: 'zh-CN',
    targetLocale: schema.locale,
    category: schema.categoryLabel,
    fields: generationFields(schema, context.facts).map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      generationMode: field.source === 'AI_GENERATED' ? 'COPY' : 'INFERENCE',
      maxLength: field.maxLength,
      minItems: field.minItems,
      maxItems: field.maxItems,
      itemMaxLength: field.itemMaxLength,
    })),
  }));
  return [{
    role: 'system',
    content: [
      '你是跨境电商多平台 Listing Agent。根据已确认的商品事实，以平台为单位生成可审核的 Listing 草稿。',
      '当前阶段生成的是中文审校稿：无论目标市场和 targetLocale 是什么，所有标题、卖点、描述、标签和搜索词等可读内容都必须使用简体中文。',
      '品牌、型号、SKU、国际通用专有名称可保留原文；数字、尺寸和单位不得擅自改写。targetLocale 仅是后续发布阶段的本地化目标，不得用它决定本次输出语言。',
      'generationMode=COPY 的字段可以基于事实进行营销创作；generationMode=INFERENCE 的字段是平台要求但商品档案缺失的字段，只能给出可由现有事实合理推断的候选值。',
      '每个 INFERENCE 目标都要给出候选值。可以基于图片外观和已知事实合理推断；确实无从判断时使用平台可接受的中文中性值（如“无品牌”、“未标明”），绝不能伪造认证或编造具体数值。',
      'INFERENCE 字段会在界面标记为“AI 推断待确认”，卖家确认后才能通过校验。',
      '不要填写价格、库存、SKU 等 SELLER_INPUT 字段。每个平台应采用不同的中文标题、卖点结构和语气，体现平台差异，不得仅复制同一份文案。',
      '严格遵守字段类型、数量和长度限制。输出标准 JSON，不要输出 Markdown。',
      '结构：{"drafts":[{"draftId":"draft_x","fields":{"title":"...","selling_points":["..."]}}],"notes":[]}',
    ].join('\n'),
  }, {
    role: 'user',
    content: JSON.stringify({ productName: context.productName, facts, targets }),
  }];
}
