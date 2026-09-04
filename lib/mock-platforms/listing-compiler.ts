import type { ListingDraftPayload, ListingFieldDefinition, MockListingSchema } from '../domain/listing';
import type { DraftValidationIssue, PlatformDraft, ProductFact, ProductPassport } from '../domain/product-passport';

function usableFact(fact: ProductFact | undefined): fact is ProductFact {
  return Boolean(fact && fact.value !== null && fact.status !== 'MISSING' && fact.status !== 'CONFLICT');
}

function renderFact(fact: ProductFact): unknown {
  if (!fact.unit) return fact.value;
  if (typeof fact.value === 'number' || typeof fact.value === 'string') return `${fact.value} ${fact.unit}`;
  return fact.value;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function validateField(field: ListingFieldDefinition, value: unknown): DraftValidationIssue[] {
  const issues: DraftValidationIssue[] = [];
  if (field.required && isEmpty(value)) {
    issues.push({
      code: field.source === 'SELLER_INPUT' ? 'seller_input_required' : 'required_value_empty',
      path: field.key,
      severity: 'error',
      message: field.source === 'SELLER_INPUT' ? `${field.label}需要卖家填写。` : `${field.label}尚未生成或缺少可信事实。`,
    });
    return issues;
  }
  if (isEmpty(value)) return issues;
  if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    issues.push({ code: 'invalid_number', path: field.key, severity: 'error', message: `${field.label}必须是有效的非负数字。` });
  }
  if ((field.type === 'string' || field.type === 'text') && typeof value !== 'string') {
    issues.push({ code: 'invalid_string', path: field.key, severity: 'error', message: `${field.label}必须是文本。` });
  }
  if (typeof value === 'string' && field.maxLength && value.length > field.maxLength) {
    issues.push({ code: 'max_length', path: field.key, severity: 'error', message: `${field.label}超过 ${field.maxLength} 个字符。` });
  }
  if (field.type === 'string_array') {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      issues.push({ code: 'invalid_array', path: field.key, severity: 'error', message: `${field.label}必须是文本列表。` });
    } else {
      if (field.minItems && value.length < field.minItems) issues.push({ code: 'min_items', path: field.key, severity: 'error', message: `${field.label}至少需要 ${field.minItems} 条。` });
      if (field.maxItems && value.length > field.maxItems) issues.push({ code: 'max_items', path: field.key, severity: 'error', message: `${field.label}最多允许 ${field.maxItems} 条。` });
      if (field.itemMaxLength && value.some((item) => item.length > field.itemMaxLength!)) {
        issues.push({ code: 'item_max_length', path: field.key, severity: 'error', message: `${field.label}中的单条内容过长。` });
      }
    }
  }
  return issues;
}

export function validateMockListing(schema: MockListingSchema, fields: Record<string, unknown>): DraftValidationIssue[] {
  return schema.fields.flatMap((field) => validateField(field, fields[field.key]));
}

export function compileMockListingDraft(input: {
  passport: ProductPassport;
  draft: PlatformDraft;
  schema: MockListingSchema;
  generatedFields?: Record<string, unknown>;
  existingFields?: Record<string, unknown>;
}): { payload: ListingDraftPayload; validationIssues: DraftValidationIssue[]; mappedFields: number } {
  const factByKey = new Map(input.passport.facts.map((fact) => [fact.key, fact]));
  const fields: Record<string, unknown> = { ...(input.existingFields ?? {}) };
  for (const field of input.schema.fields) {
    if (field.source === 'PRODUCT_FACT' && field.factKey) {
      const fact = factByKey.get(field.factKey);
      if (usableFact(fact)) fields[field.key] = renderFact(fact);
    }
    if (field.source === 'AI_GENERATED' && input.generatedFields && field.key in input.generatedFields) {
      fields[field.key] = input.generatedFields[field.key];
    }
  }
  const payload: ListingDraftPayload = {
    mode: 'MOCK',
    schema: input.schema,
    fields,
    source: { passportId: input.passport.id, passportVersion: input.passport.version },
  };
  return {
    payload,
    validationIssues: validateMockListing(input.schema, fields),
    mappedFields: Object.keys(fields).filter((key) => !isEmpty(fields[key])).length,
  };
}

export function isListingDraftPayload(value: unknown): value is ListingDraftPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.mode === 'MOCK' && Boolean(record.schema && typeof record.schema === 'object') && Boolean(record.fields && typeof record.fields === 'object');
}
