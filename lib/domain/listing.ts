import type { PlatformId } from './platform';

export type ListingFieldType = 'string' | 'text' | 'number' | 'string_array' | 'boolean' | 'variants';
export type ListingFieldSource = 'PRODUCT_FACT' | 'AI_GENERATED' | 'AI_INFERRED' | 'SELLER_INPUT';

export interface ListingFieldDefinition {
  key: string;
  label: string;
  type: ListingFieldType;
  source: ListingFieldSource;
  required: boolean;
  factKey?: string;
  allowAiInference?: boolean;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  itemMaxLength?: number;
  unit?: string;
  placeholder?: string;
  helpText?: string;
  options?: Array<{ value: string; label: string }>;
  lookup?: string;
  group?: string;
}

export interface MockListingSchema {
  mode: 'MOCK' | 'SHOPIFY_API';
  platformId: PlatformId;
  platformName: string;
  market: string;
  locale: string;
  categoryId: string;
  categoryLabel: string;
  schemaVersion: string;
  fields: ListingFieldDefinition[];
  unsupportedFields?: string[];
  storeDomain?: string;
  fetchedAt?: string;
  accessScopes?: string[];
}

export interface ListingDraftPayload {
  mode: 'MOCK' | 'SHOPIFY_API';
  reviewLocale: 'zh-CN';
  schema: MockListingSchema;
  fields: Record<string, unknown>;
  fieldSources: Record<string, ListingFieldSource>;
  fieldEvidence?: Record<string, ListingFieldEvidence>;
  fieldNotes?: Record<string, string>;
  confirmedInferredFields: string[];
  source: {
    passportId: string;
    passportVersion: number;
  };
  localization?: {
    status: 'READY';
    sourceLocale: 'zh-CN';
    targetLocale: string;
    targetLanguage: string;
    fields: Record<string, unknown>;
    model: string;
    requestId: string | null;
    createdAt: string;
  };
  mockPublication?: {
    draftId: string;
    status: 'DRAFT_CREATED';
    createdAt: string;
  };
  sandboxPublication?: {
    provider: 'AMAZON_STATIC_SANDBOX';
    createdAt: string;
    request: { sku: string; productType: string; body: { productType: string; requirements: 'LISTING'; attributes: Record<string, unknown> } };
    response: { status: string; sandboxSku: string | null; submissionId: string | null; issueCodes: string[] };
    mediaPlanId: string;
    mediaAssetIds: string[];
  };
  testPublication?: {
    provider: 'SHOPIFY_DEV';
    productId: string;
    variantId: string | null;
    handle: string | null;
    adminUrl: string | null;
    status: 'DRAFT_CREATED';
    createdAt: string;
    warnings: string[];
    submittedProduct?: Record<string, any>;
    verification?: Array<{ field: string; status: string; expected?: unknown; actual?: unknown }>;
  };
}

export interface GeneratedListingDraft {
  draftId: string;
  fields: Record<string, unknown>;
  suppliedFields?: Record<string, { value: unknown; evidence: ListingFieldEvidence }>;
  fieldNotes?: Record<string, string>;
}

export interface ListingFieldEvidence {
  sourceId: string;
  sourceLabel: string;
  sourceKind: 'DOCUMENT' | 'USER_INPUT' | 'FACT';
  quote: string;
}

export interface ListingGenerationOutput {
  drafts: GeneratedListingDraft[];
  notes: string[];
}
