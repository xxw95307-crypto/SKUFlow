import { REQUIRED_FACT_DEFINITIONS, factValueKey } from '../agents/fact-extraction';
import type {
  AgentRun,
  ExtractedCandidate,
  ExtractionEvidenceItem,
  FactExtractionOutput,
  FactExtractionSummary,
} from '../domain/fact-extraction';
import type {
  ConflictCandidate,
  FactValue,
  ProductFact,
  ProductPassport,
} from '../domain/product-passport';

interface AgentRunRow {
  id: string;
  task_id: string;
  passport_id: string;
  provider: 'BAILIAN';
  model: string;
  prompt_version: string;
  status: AgentRun['status'];
  input_hash: string;
  result_json: string | null;
  usage_json: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    taskId: row.task_id,
    passportId: row.passport_id,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    status: row.status,
    inputHash: row.input_hash,
    result: parseJson<FactExtractionOutput | null>(row.result_json, null),
    usage: parseJson<Record<string, number> | null>(row.usage_json, null),
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function getLatestAgentRun(DB: D1Database, taskId: string): Promise<AgentRun | null> {
  const row = await DB.prepare(
    `SELECT id, task_id, passport_id, provider, model, prompt_version, status, input_hash,
            result_json, usage_json, error, created_at, completed_at
     FROM agent_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(taskId).first<AgentRunRow>();
  return row ? mapAgentRun(row) : null;
}

export function prepareAgentRunStart(DB: D1Database, run: AgentRun): D1PreparedStatement {
  return DB.prepare(
    `INSERT INTO agent_runs
     (id, task_id, passport_id, provider, model, prompt_version, status, input_hash,
      result_json, usage_json, error, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, NULL, NULL, NULL, ?, NULL)`,
  ).bind(run.id, run.taskId, run.passportId, run.provider, run.model, run.promptVersion, run.inputHash, run.createdAt);
}

export function prepareAgentRunFailure(DB: D1Database, runId: string, error: string, completedAt: string): D1PreparedStatement {
  return DB.prepare(
    `UPDATE agent_runs SET status = 'FAILED', error = ?, completed_at = ? WHERE id = ?`,
  ).bind(error.slice(0, 500), completedAt, runId);
}

function evidenceLabel(item: ExtractionEvidenceItem): string {
  if (item.locator.kind === 'PAGE') return `${item.filename} · 第 ${item.locator.page} 页`;
  if (item.locator.kind === 'TABLE_RANGE') return `${item.filename} · ${item.locator.sheet ?? '工作表'} ${item.locator.range ?? ''}`.trim();
  if (item.locator.kind === 'TEXT_LINES') return `${item.filename} · 行 ${item.locator.lineStart ?? '?'}–${item.locator.lineEnd ?? '?'}`;
  if (item.sourceKind === 'VISION') return `${item.filename} · 图片证据`;
  return item.filename;
}

function dedupeCandidates(candidates: ExtractedCandidate[]): ExtractedCandidate[] {
  const byValue = new Map<string, ExtractedCandidate>();
  for (const candidate of candidates) {
    const key = factValueKey(candidate.value, candidate.unit);
    const existing = byValue.get(key);
    if (!existing || candidate.confidence > existing.confidence) {
      byValue.set(key, {
        ...candidate,
        evidenceRefs: [...new Set([...(existing?.evidenceRefs ?? []), ...candidate.evidenceRefs])],
      });
    } else {
      existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...candidate.evidenceRefs])];
    }
  }
  return [...byValue.values()];
}

function hasValue(fact: ProductFact | undefined): fact is ProductFact & { value: Exclude<FactValue, null> } {
  return Boolean(fact && fact.value !== null && fact.value !== '');
}

export async function applyFactExtraction(
  DB: D1Database,
  input: {
    runId: string;
    passport: ProductPassport;
    evidenceItems: ExtractionEvidenceItem[];
    output: FactExtractionOutput;
    usage: Record<string, number> | null;
    model: string;
    imageBlocksPending: number;
    now: string;
  },
): Promise<FactExtractionSummary> {
  const evidenceByRef = new Map(input.evidenceItems.map((item) => [item.ref, item]));
  const existingByKey = new Map(input.passport.facts.map((fact) => [fact.key, fact]));
  const extractedByKey = new Map(input.output.facts.map((fact) => [fact.key, fact]));
  const usedRefs = new Set<string>();
  for (const fact of input.output.facts) {
    fact.evidenceRefs.forEach((ref) => usedRefs.add(ref));
    fact.alternatives.forEach((candidate) => candidate.evidenceRefs.forEach((ref) => usedRefs.add(ref)));
  }

  const evidenceIdByRef = new Map<string, string>();
  const evidenceWrites: D1PreparedStatement[] = [];
  for (const ref of usedRefs) {
    const item = evidenceByRef.get(ref);
    if (!item) continue;
    const evidenceId = `evidence_${input.runId}_${ref.toLowerCase()}`;
    evidenceIdByRef.set(ref, evidenceId);
    evidenceWrites.push(DB.prepare(
      `INSERT INTO evidence_records
       (id, task_id, file_id, source_kind, locator_json, excerpt, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      evidenceId,
      input.passport.taskId,
      item.fileId,
      item.sourceKind,
      JSON.stringify(item.locator),
      item.excerpt.slice(0, 1_000),
      item.contentHash,
      input.now,
    ));
  }

  const factWrites: D1PreparedStatement[] = [];
  const linkWrites: D1PreparedStatement[] = [];
  const conflictWrites: D1PreparedStatement[] = [DB.prepare(
    `DELETE FROM fact_conflicts WHERE passport_id = ? AND status = 'OPEN'`,
  ).bind(input.passport.id)];
  let confirmedPreserved = 0;
  let conflicts = 0;
  const processedKeys = new Set<string>();

  for (const extracted of input.output.facts) {
    const existing = existingByKey.get(extracted.key);
    const candidates = dedupeCandidates([extracted, ...extracted.alternatives]);
    const existingIsConfirmed = hasValue(existing) && existing.status === 'CONFIRMED' && existing.sourceKind === 'USER_INPUT';
    if (existingIsConfirmed && !candidates.some((candidate) => factValueKey(candidate.value, candidate.unit) === factValueKey(existing.value, existing.unit))) {
      candidates.unshift({ value: existing.value, unit: existing.unit, confidence: 1, evidenceRefs: [] });
    }
    const hasConflict = candidates.length > 1;
    const selected = existingIsConfirmed ? { value: existing.value, unit: existing.unit, confidence: 1 } : candidates[0];
    const factId = existing?.id ?? `fact_${crypto.randomUUID()}`;
    const allRefs = [...new Set(candidates.flatMap((candidate) => candidate.evidenceRefs))];
    const status = hasConflict ? 'CONFLICT' : existingIsConfirmed ? 'CONFIRMED' : 'EXTRACTED';
    const extractedSourceKind = selected.evidenceRefs
      .map((ref) => evidenceByRef.get(ref)?.sourceKind)
      .find((sourceKind) => sourceKind === 'VISION' || sourceKind === 'OCR' || sourceKind === 'FILE_TEXT');
    const sourceKind = existingIsConfirmed ? 'USER_INPUT' : extractedSourceKind ?? 'FILE_TEXT';
    if (existingIsConfirmed && !hasConflict) confirmedPreserved += 1;

    if (existing) {
      factWrites.push(DB.prepare(
        `UPDATE product_facts
         SET label = ?, value_json = ?, unit = ?, status = ?, confidence = ?, source_kind = ?, updated_at = ?
         WHERE id = ? AND passport_id = ?`,
      ).bind(extracted.label, JSON.stringify(selected.value), selected.unit, status, selected.confidence, sourceKind, input.now, factId, input.passport.id));
    } else {
      factWrites.push(DB.prepare(
        `INSERT INTO product_facts
         (id, passport_id, variant_id, fact_key, label, value_json, unit, status, confidence, source_kind, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(factId, input.passport.id, extracted.key, extracted.label, JSON.stringify(selected.value), selected.unit, status, selected.confidence, sourceKind, input.now, input.now));
    }
    for (const ref of allRefs) {
      const evidenceId = evidenceIdByRef.get(ref);
      if (evidenceId) linkWrites.push(DB.prepare(
        `INSERT OR IGNORE INTO fact_evidence_links (fact_id, evidence_id, relation) VALUES (?, ?, 'supports')`,
      ).bind(factId, evidenceId));
    }

    if (hasConflict) {
      conflicts += 1;
      const conflictCandidates: ConflictCandidate[] = candidates.map((candidate, index) => ({
        id: `candidate_${input.runId}_${extracted.key.replace(/[^a-z0-9]/g, '_')}_${index + 1}`,
        value: candidate.value,
        unit: candidate.unit,
        confidence: candidate.confidence,
        sourceKind: candidate.evidenceRefs
          .map((ref) => evidenceByRef.get(ref)?.sourceKind)
          .find((sourceKind) => sourceKind !== undefined),
        sourceLabel: candidate.evidenceRefs[0]
          ? evidenceLabel(evidenceByRef.get(candidate.evidenceRefs[0]) as ExtractionEvidenceItem)
          : '用户确认值',
        evidenceIds: candidate.evidenceRefs.flatMap((ref) => evidenceIdByRef.get(ref) ?? []),
      }));
      conflictWrites.push(DB.prepare(
        `INSERT INTO fact_conflicts
         (id, passport_id, fact_key, status, candidates_json, resolution_json, created_at, updated_at)
         VALUES (?, ?, ?, 'OPEN', ?, NULL, ?, ?)`,
      ).bind(`conflict_${crypto.randomUUID()}`, input.passport.id, extracted.key, JSON.stringify(conflictCandidates), input.now, input.now));
    }
    processedKeys.add(extracted.key);
  }

  for (const definition of REQUIRED_FACT_DEFINITIONS) {
    if (processedKeys.has(definition.key)) continue;
    const existing = existingByKey.get(definition.key);
    if (hasValue(existing)) continue;
    if (existing) {
      factWrites.push(DB.prepare(
        `UPDATE product_facts
         SET label = ?, value_json = 'null', unit = NULL, status = 'MISSING', confidence = NULL, updated_at = ?
         WHERE id = ? AND passport_id = ?`,
      ).bind(definition.label, input.now, existing.id, input.passport.id));
    } else {
      factWrites.push(DB.prepare(
        `INSERT INTO product_facts
         (id, passport_id, variant_id, fact_key, label, value_json, unit, status, confidence, source_kind, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'null', NULL, 'MISSING', NULL, 'RULE_ENGINE', ?, ?)`,
      ).bind(`fact_${crypto.randomUUID()}`, input.passport.id, definition.key, definition.label, input.now, input.now));
    }
    processedKeys.add(definition.key);
  }

  const missing = REQUIRED_FACT_DEFINITIONS.filter((definition) => {
    const extracted = extractedByKey.get(definition.key);
    if (extracted) return false;
    return !hasValue(existingByKey.get(definition.key));
  }).length;
  const summary: FactExtractionSummary = {
    factsExtracted: input.output.facts.length,
    confirmedPreserved,
    missing,
    conflicts,
    evidenceCreated: evidenceWrites.length,
    imageBlocksPending: input.imageBlocksPending,
    model: input.model,
  };

  await DB.batch([
    ...evidenceWrites,
    ...factWrites,
    ...linkWrites,
    ...conflictWrites,
    DB.prepare('UPDATE product_passports SET version = version + 1, updated_at = ? WHERE id = ?')
      .bind(input.now, input.passport.id),
    DB.prepare(
      `UPDATE agent_runs
       SET status = 'COMPLETED', model = ?, result_json = ?, usage_json = ?, error = NULL, completed_at = ?
       WHERE id = ?`,
    ).bind(input.model, JSON.stringify(input.output), JSON.stringify(input.usage), input.now, input.runId),
  ]);

  return summary;
}
