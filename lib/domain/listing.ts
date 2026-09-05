import type { PlatformId } from './platform';

export type ListingFieldType = 'string' | 'text' | 'number' | 'string_array';
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
}

export interface MockListingSchema {
  mode: 'MOCK';
  platformId: PlatformId;
  platformName: string;
  market: string;
  locale: string;
  categoryId: string;
  categoryLabel: string;
  schemaVersion: string;
  fields: ListingFieldDefinition[];
}

export interface ListingDraftPayload {
  mode: 'MOCK';
  reviewLocale: 'zh-CN';
  schema: MockListingSchema;
  fields: Record<string, unknown>;
  fieldSources: Record<string, ListingFieldSource>;
  confirmedInferredFields: string[];
  source: {
    passportId: string;
    passportVersion: number;
  };
  mockPublication?: {
    draftId: string;
    status: 'DRAFT_CREATED';
    createdAt: string;
  };
}

export interface GeneratedListingDraft {
  draftId: string;
  fields: Record<string, unknown>;
}

export interface ListingGenerationOutput {
  drafts: GeneratedListingDraft[];
  notes: string[];
}
