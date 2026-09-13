import type { ListingFieldDefinition, GeneratedListingDraft } from '../domain/listing.ts';

export interface ListingEvidenceSource { id: string; label: string; kind: 'DOCUMENT' | 'USER_INPUT' | 'FACT'; text: string }
export const emptyListingValue = (value: unknown): boolean => value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);

// Values must be traceable to literal evidence, not merely accompanied by a citation.
function supported(value: unknown, quote: string): boolean {
  if (typeof value === 'string') return !!value.trim() && quote.includes(value.trim());
  if (typeof value === 'number') return Number.isFinite(value) && (quote.match(/-?\d+(?:\.\d+)?/g) ?? []).some(n => Number(n) === value);
  if (typeof value === 'boolean') return value ? /true|是|需要|启用|跟踪/.test(quote) && !/false|不|无需|关闭/.test(quote) : /false|否|不|无需|关闭/.test(quote);
  if (Array.isArray(value)) return value.length > 0 && value.every(v => supported(v, quote));
  return false;
}
const currencyNames: Record<string, RegExp> = { USD: /\bUSD\b|美元|美金|US\$/i, CNY: /\bCNY\b|\bRMB\b|人民币/i, JPY: /\bJPY\b|日元/i, EUR: /\bEUR\b|欧元/i, GBP: /\bGBP\b|英镑/i, BRL: /\bBRL\b|雷亚尔/i };
function supportedBoolean(value: unknown, field: ListingFieldDefinition, quote: string): boolean {
  if (typeof value !== 'boolean') return false;
  const subject = ({taxable:/收税|征税|tax/i,requires_shipping:/运输|配送|shipping/i,inventory_tracked:/库存|inventory|tracked/i} as Record<string,RegExp>)[field.key];
  const clauses = quote.split(/[，,；;。\n]/).filter(c => subject ? subject.test(c) : c.includes(field.label));
  if (!clauses.length) return false;
  return clauses.every(c => {
    const negative = /false|\bno\b|\bnot\b|不|无需|关闭|禁用|：否|:否/i.test(c);
    const positive = /true|\byes\b|需要|启用|开启|跟踪|：是|:是/i.test(c);
    return value ? positive && !negative : negative;
  });
}

export function parseSuppliedFields(raw: unknown, fields: ListingFieldDefinition[], sources: ListingEvidenceSource[]): Pick<GeneratedListingDraft, 'suppliedFields' | 'fieldNotes'> {
  const suppliedFields: NonNullable<GeneratedListingDraft['suppliedFields']> = {};
  const fieldNotes: Record<string, string> = {};
  if (Array.isArray(raw)) {
    const entries = raw.filter(v => v && typeof v === 'object' && typeof v.key === 'string');
    raw = Object.fromEntries(entries.map(v => [v.key, entries.filter(e => e.key === v.key).length === 1 ? v : {reason:'同一字段返回多个值，请确认。'}]));
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { suppliedFields, fieldNotes };
  for (const field of fields.filter(f => f.source !== 'AI_GENERATED')) {
    const binding = (raw as Record<string, any>)[field.key];
    if (!binding || typeof binding !== 'object') continue;
    if (typeof binding.reason === 'string' && binding.reason.trim()) { fieldNotes[field.key] = binding.reason.slice(0, 240); continue; }
    const source = sources.find(s => s.id === binding.sourceId);
    const quote = typeof binding.quote === 'string' ? binding.quote.trim() : '';
    if (!source || !quote || !source.text.includes(quote)) continue;
    let value = binding.value;
    if (field.type === 'number' && typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) value = Number(value);
    let valid = supported(value, quote);
    if (field.type === 'number') valid &&= typeof value === 'number' && value >= 0;
    if (field.type === 'boolean') valid = supportedBoolean(value, field, quote);
    if (field.type === 'string' || field.type === 'text') valid &&= typeof value === 'string';
    if (field.type === 'string_array') valid &&= Array.isArray(value) && value.every(v => typeof v === 'string');
    if (field.lookup || field.options) {
      const selected = Array.isArray(value) ? value : [value];
      valid = selected.length > 0 && selected.every(v => {
        const exactId = field.options?.find(o => o.value === v && quote.includes(o.value));
        const matches = field.options?.filter(o => quote.includes(o.label)) ?? [];
        return !!exactId || (matches.length === 1 && matches[0].value === v);
      });
    }
    if (field.type === 'variants') {
      valid = Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(row => {
        if (!row || typeof row !== 'object' || typeof row.options !== 'string') return false;
        const optionValues = row.options.split(/[;；]/).flatMap((p: string) => p.split(/[=＝]/));
        return optionValues.length >= 2 && optionValues.every((v: string) => supported(v.trim(), quote)) &&
          Object.entries(row).every(([k,v]) => k === 'options' || (['sku','price','quantity','barcode','weight'].includes(k) && (emptyListingValue(v) || supported(v, quote))));
      });
    }
    if (field.unit && /^[A-Z]{3}$/.test(field.unit) && !(currencyNames[field.unit] ?? new RegExp(`\\b${field.unit}\\b`)).test(quote)) {
      valid = false; fieldNotes[field.key] = `资料币种未明确为 ${field.unit}，请确认，系统不会自行换算。`;
    }
    if (field.unit && /^[A-Z]{3}$/.test(field.unit) && Object.entries(currencyNames).some(([code, pattern]) => code !== field.unit && pattern.test(quote))) {
      valid = false; fieldNotes[field.key] = '证据中包含其他币种，请明确本次使用的价格与币种。';
    }
    if (['variant_price','standard_price','price'].includes(field.key) && /成本|采购|建议|cost|wholesale|recommended/i.test(quote) && !/实际售价|销售价|零售价|售价|selling price|retail price/i.test(quote)) {
      valid = false; fieldNotes[field.key] = '资料提供的是成本或建议价格，请明确实际售价。';
    }
    if (!valid) { fieldNotes[field.key] ??= '资料中的值或对应关系不够明确，请核对后补充。'; continue; }
    suppliedFields[field.key] = { value, evidence: {sourceId: source.id, sourceLabel: source.label, sourceKind: source.kind, quote} };
  }
  return { suppliedFields, fieldNotes };
}

export function listingRequirement(field: ListingFieldDefinition, fields: Record<string, unknown>): boolean {
  if (['variant_sku','variant_price'].includes(field.key)) return !Array.isArray(fields.variants) || !fields.variants.length;
  if (field.key === 'shipping_weight') return fields.requires_shipping === true && !(Array.isArray(fields.variants) && fields.variants.length);
  if (field.key === 'inventory_quantity') return fields.inventory_tracked === true && !(Array.isArray(fields.variants) && fields.variants.length);
  if (field.key === 'inventory_location') return fields.inventory_tracked === true;
  return field.required;
}

export function sellerFieldLabel(value: unknown, required: boolean): string {
  return emptyListingValue(value) ? (required ? '需要卖家补充' : '可选，未设置') : '卖家已填写';
}
