import type { PlatformId } from '../domain/platform';
import {
  createInitialProductPassport,
  type ConflictCandidate,
  type ConflictResolution,
  type DraftValidationIssue,
  type EvidenceLocator,
  type EvidenceRecord,
  type EvidenceSourceKind,
  type FactConflict,
  type FactStatus,
  type FactValue,
  type PlatformDraft,
  type PlatformDraftStatus,
  type ProductFact,
  type ProductPassport,
  type ProductPassportStatus,
  type ProductVariant,
} from '../domain/product-passport';

interface PassportRow {
  id: string;
  task_id: string;
  version: number;
  status: ProductPassportStatus;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VariantRow {
  id: string;
  sku: string;
  attributes_json: string;
  created_at: string;
  updated_at: string;
}

interface FactRow {
  id: string;
  variant_id: string | null;
  fact_key: string;
  label: string;
  value_json: string;
  unit: string | null;
  status: FactStatus;
  confidence: number | null;
  source_kind: EvidenceSourceKind;
  created_at: string;
  updated_at: string;
}

interface EvidenceRow {
  id: string;
  task_id: string;
  file_id: string | null;
  source_kind: EvidenceSourceKind;
  locator_json: string;
  excerpt: string | null;
  content_hash: string | null;
  created_at: string;
}

interface ConflictRow {
  id: string;
  fact_key: string;
  status: FactConflict['status'];
  candidates_json: string;
  resolution_json: string | null;
  created_at: string;
  updated_at: string;
}

interface DraftRow {
  id: string;
  task_id: string;
  passport_id: string;
  platform_id: PlatformId;
  market: string;
  locale: string;
  category_id: string | null;
  status: PlatformDraftStatus;
  schema_version: string | null;
  payload_json: string;
  validation_json: string;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function prepareInitialPassportWrites(
  DB: D1Database,
  passport: ProductPassport,
): D1PreparedStatement[] {
  const writes: D1PreparedStatement[] = [
    DB.prepare(
      `INSERT INTO product_passports (id, task_id, version, status, locked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(passport.id, passport.taskId, passport.version, passport.status, passport.lockedAt, passport.createdAt, passport.updatedAt),
    ...passport.facts.map((fact) => DB.prepare(
      `INSERT INTO product_facts
       (id, passport_id, variant_id, fact_key, label, value_json, unit, status, confidence, source_kind, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      fact.id,
      passport.id,
      fact.key,
      fact.label,
      JSON.stringify(fact.value),
      fact.unit,
      fact.status,
      fact.confidence,
      fact.sourceKind,
      fact.createdAt,
      fact.updatedAt,
    )),
    ...passport.evidence.map((evidence) => DB.prepare(
      `INSERT INTO evidence_records
       (id, task_id, file_id, source_kind, locator_json, excerpt, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      evidence.id,
      evidence.taskId,
      evidence.fileId,
      evidence.sourceKind,
      JSON.stringify(evidence.locator),
      evidence.excerpt,
      evidence.contentHash,
      evidence.createdAt,
    )),
    ...passport.facts.flatMap((fact) => fact.evidenceIds.map((evidenceId) => DB.prepare(
      `INSERT INTO fact_evidence_links (fact_id, evidence_id, relation) VALUES (?, ?, 'supports')`,
    ).bind(fact.id, evidenceId))),
    ...passport.platformDrafts.map((draft) => DB.prepare(
      `INSERT INTO platform_drafts
       (id, task_id, passport_id, platform_id, market, locale, category_id, status, schema_version, payload_json, validation_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      draft.id,
      draft.taskId,
      draft.passportId,
      draft.platformId,
      draft.market,
      draft.locale,
      draft.categoryId,
      draft.status,
      draft.schemaVersion,
      JSON.stringify(draft.payload),
      JSON.stringify(draft.validationIssues),
      draft.createdAt,
      draft.updatedAt,
    )),
  ];

  return writes;
}

async function findLatestPassportRow(DB: D1Database, taskId: string): Promise<PassportRow | null> {
  return DB.prepare(
    `SELECT id, task_id, version, status, locked_at, created_at, updated_at
     FROM product_passports WHERE task_id = ? ORDER BY version DESC LIMIT 1`,
  ).bind(taskId).first<PassportRow>();
}

export async function ensureProductPassport(DB: D1Database, taskId: string): Promise<void> {
  if (await findLatestPassportRow(DB, taskId)) return;

  const task = await DB.prepare(
    `SELECT product_name, platforms_json, markets_json FROM tasks WHERE id = ?`,
  ).bind(taskId).first<{ product_name: string; platforms_json: string; markets_json: string }>();
  if (!task) throw new Error('Task not found');

  const passport = createInitialProductPassport({
    taskId,
    productName: task.product_name,
    platforms: parseJson<PlatformId[]>(task.platforms_json, []),
    markets: parseJson<string[]>(task.markets_json, []),
  });
  await DB.batch(prepareInitialPassportWrites(DB, passport));
}

export async function getProductPassport(DB: D1Database, taskId: string): Promise<ProductPassport | null> {
  await ensureProductPassport(DB, taskId);
  const passport = await findLatestPassportRow(DB, taskId);
  if (!passport) return null;

  const [variantResult, factResult, evidenceResult, linkResult, conflictResult, draftResult] = await Promise.all([
    DB.prepare(
      `SELECT id, sku, attributes_json, created_at, updated_at
       FROM product_variants WHERE passport_id = ? ORDER BY created_at ASC`,
    ).bind(passport.id).all<VariantRow>(),
    DB.prepare(
      `SELECT id, variant_id, fact_key, label, value_json, unit, status, confidence, source_kind, created_at, updated_at
       FROM product_facts WHERE passport_id = ? ORDER BY created_at ASC`,
    ).bind(passport.id).all<FactRow>(),
    DB.prepare(
      `SELECT id, task_id, file_id, source_kind, locator_json, excerpt, content_hash, created_at
       FROM evidence_records WHERE task_id = ? ORDER BY created_at ASC`,
    ).bind(taskId).all<EvidenceRow>(),
    DB.prepare(
      `SELECT fact_id, evidence_id FROM fact_evidence_links
       WHERE fact_id IN (SELECT id FROM product_facts WHERE passport_id = ?)`,
    ).bind(passport.id).all<{ fact_id: string; evidence_id: string }>(),
    DB.prepare(
      `SELECT id, fact_key, status, candidates_json, resolution_json, created_at, updated_at
       FROM fact_conflicts WHERE passport_id = ? ORDER BY created_at ASC`,
    ).bind(passport.id).all<ConflictRow>(),
    DB.prepare(
      `SELECT id, task_id, passport_id, platform_id, market, locale, category_id, status, schema_version,
              payload_json, validation_json, created_at, updated_at
       FROM platform_drafts WHERE passport_id = ? ORDER BY platform_id, market`,
    ).bind(passport.id).all<DraftRow>(),
  ]);

  const evidenceByFact = new Map<string, string[]>();
  for (const link of linkResult.results) {
    evidenceByFact.set(link.fact_id, [...(evidenceByFact.get(link.fact_id) ?? []), link.evidence_id]);
  }

  const facts = factResult.results.map<ProductFact>((fact) => ({
    id: fact.id,
    key: fact.fact_key,
    label: fact.label,
    value: parseJson<FactValue>(fact.value_json, null),
    unit: fact.unit,
    status: fact.status,
    confidence: fact.confidence,
    sourceKind: fact.source_kind,
    evidenceIds: evidenceByFact.get(fact.id) ?? [],
    createdAt: fact.created_at,
    updatedAt: fact.updated_at,
  }));

  const rootFacts = facts.filter((_fact, index) => factResult.results[index]?.variant_id === null);
  const variants: ProductVariant[] = variantResult.results.map((variant) => ({
    id: variant.id,
    sku: variant.sku,
    attributes: parseJson<Record<string, string>>(variant.attributes_json, {}),
    facts: facts.filter((_fact, index) => factResult.results[index]?.variant_id === variant.id),
    createdAt: variant.created_at,
    updatedAt: variant.updated_at,
  }));
  const evidence: EvidenceRecord[] = evidenceResult.results.map((record) => ({
    id: record.id,
    taskId: record.task_id,
    fileId: record.file_id,
    sourceKind: record.source_kind,
    locator: parseJson<EvidenceLocator>(record.locator_json, { kind: 'JSON_PATH', path: 'unknown' }),
    excerpt: record.excerpt,
    contentHash: record.content_hash,
    createdAt: record.created_at,
  }));
  const conflicts: FactConflict[] = conflictResult.results.map((conflict) => ({
    id: conflict.id,
    passportId: passport.id,
    factKey: conflict.fact_key,
    status: conflict.status,
    candidates: parseJson<ConflictCandidate[]>(conflict.candidates_json, []),
    resolution: parseJson<ConflictResolution | null>(conflict.resolution_json, null),
    createdAt: conflict.created_at,
    updatedAt: conflict.updated_at,
  }));
  const platformDrafts: PlatformDraft[] = draftResult.results.map((draft) => ({
    id: draft.id,
    taskId: draft.task_id,
    passportId: draft.passport_id,
    platformId: draft.platform_id,
    market: draft.market,
    locale: draft.locale,
    categoryId: draft.category_id,
    status: draft.status,
    schemaVersion: draft.schema_version,
    payload: parseJson<Record<string, unknown>>(draft.payload_json, {}),
    validationIssues: parseJson<DraftValidationIssue[]>(draft.validation_json, []),
    createdAt: draft.created_at,
    updatedAt: draft.updated_at,
  }));

  return {
    id: passport.id,
    taskId: passport.task_id,
    version: passport.version,
    status: passport.status,
    facts: rootFacts,
    variants,
    evidence,
    conflicts,
    platformDrafts,
    lockedAt: passport.locked_at,
    createdAt: passport.created_at,
    updatedAt: passport.updated_at,
  };
}
