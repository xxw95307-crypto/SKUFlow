import type { PlatformId, PlatformProfile } from '../domain/platform';
import type {
  DraftValidationIssue,
  PlatformDraft,
  ProductPassport,
} from '../domain/product-passport';

export type AdapterTransform =
  | { type: 'trim' }
  | { type: 'lowercase' }
  | { type: 'uppercase' }
  | { type: 'join'; separator: string }
  | { type: 'stringify' };

export type AdapterValidation =
  | { type: 'required' }
  | { type: 'minLength'; value: number }
  | { type: 'maxLength'; value: number };

export interface AdapterFieldRule {
  sourceFact: string;
  targetPath: string;
  label: string;
  transforms?: readonly AdapterTransform[];
  validations?: readonly AdapterValidation[];
}

export interface PlatformRuleConfig {
  schemaVersion: '1.0';
  id: string;
  version: string;
  title: string;
  fields: readonly AdapterFieldRule[];
}

export interface PlatformAdapterContext {
  passport: ProductPassport;
  platform: PlatformProfile;
  draft: PlatformDraft;
}

export interface AdapterCompileResult {
  payload: Record<string, unknown>;
  validationIssues: DraftValidationIssue[];
  mappedFields: number;
  skippedFields: number;
  schemaVersion: string;
}

export interface PlatformAdapter {
  id: string;
  name: string;
  version: string;
  priority: number;
  kind: 'fallback' | 'platform';
  supports: readonly PlatformId[];
  rules: PlatformRuleConfig;
  compile(context: PlatformAdapterContext): AdapterCompileResult | Promise<AdapterCompileResult>;
}

export interface PlatformAdapterDescriptor {
  id: string;
  name: string;
  version: string;
  priority: number;
  kind: PlatformAdapter['kind'];
  supports: readonly PlatformId[];
  ruleId: string;
  ruleVersion: string;
  fieldCount: number;
}
