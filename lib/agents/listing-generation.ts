import type { ListingGenerationOutput, MockListingSchema } from '../domain/listing';
import type { ProductFact } from '../domain/product-passport';

export const LISTING_GENERATION_PROMPT_VERSION = 'listing-mock-v1';

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

export function parseListingGenerationOutput(content: string, context: ListingGenerationContext): ListingGenerationOutput {
  const parsed = unwrapJson(content);
  if (!parsed || typeof parsed !== 'object') throw new Error('Listing Agent 未返回 JSON 对象');
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.drafts)) throw new Error('Listing Agent 结果缺少 drafts 数组');
  const allowedByDraft = new Map(context.drafts.map(({ draftId, schema }) => [
    draftId,
    new Set(schema.fields.filter((field) => field.source === 'AI_GENERATED').map((field) => field.key)),
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
    locale: schema.locale,
    category: schema.categoryLabel,
    fields: schema.fields.filter((field) => field.source === 'AI_GENERATED').map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      maxLength: field.maxLength,
      minItems: field.minItems,
      maxItems: field.maxItems,
      itemMaxLength: field.itemMaxLength,
    })),
  }));
  return [{
    role: 'system',
    content: [
      '你是跨境电商多平台 Listing Agent。根据已确认的商品事实，为每个平台和站点生成有竞争力、自然、符合当地语言习惯的营销字段。',
      '只能使用给定商品事实支撑客观陈述；不得捏造功率、认证、材质、容量、功效、兼容性或其他参数。可以从真实事实中提炼优势、使用场景和表达角度。',
      '不要填写价格、库存、SKU 等 SELLER_INPUT 字段。每个平台应采用不同的标题、卖点结构和语气，不能只是机械翻译。',
      '严格遵守字段类型、数量和长度限制。输出标准 JSON，不要输出 Markdown。',
      '结构：{"drafts":[{"draftId":"draft_x","fields":{"title":"...","selling_points":["..."]}}],"notes":[]}',
    ].join('\n'),
  }, {
    role: 'user',
    content: JSON.stringify({ productName: context.productName, facts, targets }),
  }];
}
