import type { PlatformId } from './platform';
import type { PlatformTarget } from '../platforms/market-options';

export const FACT_STATUSES = ['CONFIRMED', 'EXTRACTED', 'CONFLICT', 'MISSING'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const PASSPORT_STATUSES = ['OPEN', 'LOCKED', 'SUPERSEDED'] as const;
export type ProductPassportStatus = (typeof PASSPORT_STATUSES)[number];

export type FactValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | Record<string, string | number | boolean>
  | null;

export type EvidenceSourceKind =
  | 'USER_INPUT'
  | 'FILE_TEXT'
  | 'OCR'
  | 'VISION'
  | 'RULE_ENGINE'
  | 'PLATFORM_API';

export type EvidenceLocatorKind = 'FORM_FIELD' | 'PAGE' | 'TEXT_LINES' | 'TABLE_RANGE' | 'SHEET_CELL' | 'IMAGE_REGION' | 'JSON_PATH';

export interface EvidenceLocator {
  kind: EvidenceLocatorKind;
  path: string;
  page?: number;
  sheet?: string;
  cell?: string;
  range?: string;
  lineStart?: number;
  lineEnd?: number;
  bbox?: [number, number, number, number];
}

export interface EvidenceRecord {
  id: string;
  taskId: string;
  fileId: string | null;
  sourceKind: EvidenceSourceKind;
  locator: EvidenceLocator;
  excerpt: string | null;
  contentHash: string | null;
  createdAt: string;
}

export interface ProductFact<T extends FactValue = FactValue> {
  id: string;
  key: string;
  label: string;
  value: T;
  unit: string | null;
  status: FactStatus;
  confidence: number | null;
  sourceKind: EvidenceSourceKind;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductVariant {
  id: string;
  sku: string;
  attributes: Record<string, string>;
  facts: ProductFact[];
  createdAt: string;
  updatedAt: string;
}

export type ConflictStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

export interface ConflictCandidate {
  id: string;
  value: FactValue;
  unit?: string | null;
  confidence?: number;
  sourceKind?: EvidenceSourceKind;
  sourceLabel: string;
  evidenceIds: string[];
}

export interface ConflictResolution {
  selectedCandidateId: string | null;
  resolvedValue: FactValue;
  resolvedBy: 'user' | 'agent';
  note: string | null;
  resolvedAt: string;
}

export interface FactConflict {
  id: string;
  passportId: string;
  factKey: string;
  status: ConflictStatus;
  candidates: ConflictCandidate[];
  resolution: ConflictResolution | null;
  createdAt: string;
  updatedAt: string;
}

export type PlatformDraftStatus =
  | 'PLANNED'
  | 'GENERATING'
  | 'NEEDS_REVIEW'
  | 'VALIDATED'
  | 'APPROVED'
  | 'EXPORTED'
  | 'DRAFT_CREATED'
  | 'FAILED';

export interface DraftValidationIssue {
  code: string;
  path: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface PlatformDraft {
  id: string;
  taskId: string;
  passportId: string;
  platformId: PlatformId;
  market: string;
  locale: string;
  sceneId: string;
  categoryId: string | null;
  status: PlatformDraftStatus;
  schemaVersion: string | null;
  payload: Record<string, unknown>;
  validationIssues: DraftValidationIssue[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductPassport {
  id: string;
  taskId: string;
  version: number;
  status: ProductPassportStatus;
  facts: ProductFact[];
  variants: ProductVariant[];
  evidence: EvidenceRecord[];
  conflicts: FactConflict[];
  platformDrafts: PlatformDraft[];
  lockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InitialPassportInput {
  taskId: string;
  platforms: PlatformId[];
  markets: string[];
  targets?: PlatformTarget[];
  now?: string;
  idFactory?: () => string;
}

function defaultIdFactory(): string {
  return crypto.randomUUID();
}

export function createInitialProductPassport(input: InitialPassportInput): ProductPassport {
  const now = input.now ?? new Date().toISOString();
  const makeId = input.idFactory ?? defaultIdFactory;
  const passportId = `passport_${makeId()}`;

  const facts: ProductFact[] = [];

  const evidence: EvidenceRecord[] = [];

  const selectedTargets = input.targets ?? input.platforms.flatMap((platformId) => input.markets.map((market) => ({ platformId, market })));
  const platformDrafts: PlatformDraft[] = selectedTargets.map(({ platformId, market }) => ({
      id: `draft_${makeId()}`,
      taskId: input.taskId,
      passportId,
      platformId,
      market,
      locale: 'und',
      sceneId: 'base',
      categoryId: null,
      status: 'PLANNED' as const,
      schemaVersion: null,
      payload: {},
      validationIssues: [],
      createdAt: now,
      updatedAt: now,
    }));

  return {
    id: passportId,
    taskId: input.taskId,
    version: 1,
    status: 'OPEN',
    facts,
    variants: [],
    evidence,
    conflicts: [],
    platformDrafts,
    lockedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function isFactStatus(value: unknown): value is FactStatus {
  return typeof value === 'string' && FACT_STATUSES.includes(value as FactStatus);
}
