import type { ListingDraftPayload, ListingFieldDefinition, ListingFieldSource, MockListingSchema } from '../domain/listing';
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

export function listingFieldSources(payload: ListingDraftPayload): Record<string, ListingFieldSource> {
  return payload.fieldSources ?? Object.fromEntries(payload.schema.fields.map((field) => [field.key, field.source]));
}

export function confirmedInferredFields(payload: ListingDraftPayload): string[] {
  return Array.isArray(payload.confirmedInferredFields) ? payload.confirmedInferredFields : [];
}

export function validateMockListing(
  schema: MockListingSchema,
  fields: Record<string, unknown>,
  fieldSources: Record<string, ListingFieldSource> = {},
  confirmedInferences: string[] = [],
): DraftValidationIssue[] {
  const confirmed = new Set(confirmedInferences);
  return schema.fields.flatMap((field) => {
    const actualSource = fieldSources[field.key] ?? field.source;
    const issues = validateField({ ...field, source: actualSource }, fields[field.key]);
    if (!isEmpty(fields[field.key]) && actualSource === 'AI_INFERRED' && !confirmed.has(field.key)) {
      issues.push({
        code: 'ai_inference_confirmation_required',
        path: field.key,
        severity: 'error',
        message: `${field.label}由智能体根据现有资料推断，请卖家核对并确认。`,
      });
    }
    return issues;
  });
}

export function compileMockListingDraft(input: {
  passport: ProductPassport;
  draft: PlatformDraft;
  schema: MockListingSchema;
  generatedFields?: Record<string, unknown>;
  existingPayload?: ListingDraftPayload;
}): { payload: ListingDraftPayload; validationIssues: DraftValidationIssue[]; mappedFields: number } {
  const factByKey = new Map(input.passport.facts.map((fact) => [fact.key, fact]));
  const fields: Record<string, unknown> = { ...(input.existingPayload?.fields ?? {}) };
  const fieldSources: Record<string, ListingFieldSource> = input.existingPayload
    ? { ...listingFieldSources(input.existingPayload) }
    : {};
  const confirmed = new Set(input.existingPayload ? confirmedInferredFields(input.existingPayload) : []);
  for (const field of input.schema.fields) {
    if (field.source === 'PRODUCT_FACT' && field.factKey) {
      const fact = factByKey.get(field.factKey);
      if (usableFact(fact)) {
        fields[field.key] = renderFact(fact);
        fieldSources[field.key] = 'PRODUCT_FACT';
        confirmed.delete(field.key);
      } else if (field.allowAiInference && input.generatedFields && field.key in input.generatedFields) {
        fields[field.key] = input.generatedFields[field.key];
        fieldSources[field.key] = 'AI_INFERRED';
        confirmed.delete(field.key);
      } else if (isEmpty(fields[field.key])) {
        fieldSources[field.key] = 'SELLER_INPUT';
      }
    }
    if (field.source === 'AI_GENERATED' && input.generatedFields && field.key in input.generatedFields) {
      fields[field.key] = input.generatedFields[field.key];
      fieldSources[field.key] = 'AI_GENERATED';
    }
    if (field.source === 'SELLER_INPUT' && !fieldSources[field.key]) {
      fieldSources[field.key] = 'SELLER_INPUT';
    }
  }
  const payload: ListingDraftPayload = {
    mode: 'MOCK',
    reviewLocale: 'zh-CN',
    schema: input.schema,
    fields,
    fieldSources,
    confirmedInferredFields: [...confirmed],
    source: { passportId: input.passport.id, passportVersion: input.passport.version },
  };
  return {
    payload,
    validationIssues: validateMockListing(input.schema, fields, fieldSources, [...confirmed]),
    mappedFields: Object.keys(fields).filter((key) => !isEmpty(fields[key])).length,
  };
}

export function isListingDraftPayload(value: unknown): value is ListingDraftPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.mode === 'MOCK' && Boolean(record.schema && typeof record.schema === 'object') && Boolean(record.fields && typeof record.fields === 'object');
}
