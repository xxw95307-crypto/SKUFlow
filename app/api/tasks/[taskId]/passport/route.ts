import { ensureSchema, getBindings } from '@/db/client';
import {
  isFactStatus,
  type ConflictCandidate,
  type EvidenceSourceKind,
  type FactStatus,
  type FactValue,
  type ProductFact,
} from '@/lib/domain/product-passport';
import { getProductPassport } from '@/lib/server/passport-store';

export const dynamic = 'force-dynamic';

interface FactPatch {
  key: string;
  label: string;
  value: FactValue;
  unit: string | null;
  status: FactStatus;
  confidence: number | null;
}

interface ConflictResolutionPatch {
  conflictId: string;
  candidateId: string | null;
  manualValue: FactValue | undefined;
  unit: string | null;
}

type PassportPatch =
  | { kind: 'facts'; facts: FactPatch[] }
  | { kind: 'conflict'; resolution: ConflictResolutionPatch };

function parseFactPatches(body: unknown): FactPatch[] {
  if (!body || typeof body !== 'object' || !('facts' in body) || !Array.isArray(body.facts)) {
    throw new Error('facts must be an array');
  }
  if (body.facts.length === 0 || body.facts.length > 20) throw new Error('每次需更新 1-20 个事实字段');

  const keys = new Set<string>();
  return body.facts.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('事实字段格式无效');
    const record = item as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(key)) throw new Error(`事实字段 key 无效：${key || '(empty)'}`);
    if (keys.has(key)) throw new Error(`事实字段重复：${key}`);
    keys.add(key);
    if (label.length < 1 || label.length > 80) throw new Error(`事实字段 label 无效：${key}`);
    if (!('value' in record)) throw new Error(`事实字段缺少 value：${key}`);

    let valueJson: string;
    try {
      valueJson = JSON.stringify(record.value);
    } catch {
      throw new Error(`事实字段 value 无法序列化：${key}`);
    }
    if (valueJson === undefined || valueJson.length > 10_000) throw new Error(`事实字段 value 过大或无效：${key}`);
    const value = record.value as FactValue;
    const unit = record.unit === undefined || record.unit === null ? null : String(record.unit).trim();
    if (unit && unit.length > 20) throw new Error(`事实字段 unit 过长：${key}`);
    const status = record.status === undefined
      ? (value === null ? 'MISSING' : 'CONFIRMED')
      : record.status;
    if (!isFactStatus(status)) throw new Error(`事实字段 status 无效：${key}`);
    if ((value === null) !== (status === 'MISSING')) throw new Error(`缺失状态与字段值不一致：${key}`);
    const confidence = record.confidence === undefined || record.confidence === null
      ? (value === null ? null : 1)
      : Number(record.confidence);
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error(`事实字段 confidence 需为 0-1：${key}`);
    }

    return { key, label, value, unit: unit || null, status, confidence };
  });
}

function parseConflictResolution(body: Record<string, unknown>): ConflictResolutionPatch {
  const raw = body.conflictResolution;
  if (!raw || typeof raw !== 'object') throw new Error('conflictResolution 格式无效');
  const record = raw as Record<string, unknown>;
  const conflictId = typeof record.conflictId === 'string' ? record.conflictId.trim() : '';
  const candidateId = typeof record.candidateId === 'string' ? record.candidateId.trim() : null;
  const hasManualValue = Object.prototype.hasOwnProperty.call(record, 'manualValue');
  if (!/^conflict_[a-zA-Z0-9_-]+$/.test(conflictId)) throw new Error('冲突记录无效');
  if ((candidateId ? 1 : 0) + (hasManualValue ? 1 : 0) !== 1) {
    throw new Error('请选择一个候选值或填写一个人工确认值');
  }
  if (candidateId && !/^candidate_[a-zA-Z0-9_.-]+$/.test(candidateId)) throw new Error('冲突候选值无效');

  let manualValue: FactValue | undefined;
  if (hasManualValue) {
    manualValue = record.manualValue as FactValue;
    if (manualValue === null || (typeof manualValue === 'string' && manualValue.trim() === '')) {
      throw new Error('人工确认值不能为空');
    }
    const serialized = JSON.stringify(manualValue);
    if (serialized === undefined || serialized.length > 10_000) throw new Error('人工确认值过大或无效');
  }
  const unit = record.unit === undefined || record.unit === null ? null : String(record.unit).trim();
  if (unit && unit.length > 20) throw new Error('单位过长');
  return { conflictId, candidateId, manualValue, unit: unit || null };
}

function parsePassportPatch(body: unknown): PassportPatch {
  if (!body || typeof body !== 'object') throw new Error('请求内容格式无效');
  const record = body as Record<string, unknown>;
  if ('conflictResolution' in record) {
    return { kind: 'conflict', resolution: parseConflictResolution(record) };
  }
  return { kind: 'facts', facts: parseFactPatches(body) };
}

function evidenceExcerpt(value: FactValue): string {
  if (value === null) return '用户标记为缺失';
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return serialized.slice(0, 500);
}

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const { DB } = getBindings();
    const task = await DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(taskId).first<{ id: string }>();
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    return Response.json({ passport: await getProductPassport(DB, taskId) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to load product passport' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const patch = parsePassportPatch(await request.json());
    const { DB } = getBindings();
    const passport = await getProductPassport(DB, taskId);
    if (!passport) return Response.json({ error: 'Task not found' }, { status: 404 });
    if (passport.status === 'LOCKED') return Response.json({ error: 'Product passport is locked' }, { status: 409 });

    const now = new Date().toISOString();
    const writes: D1PreparedStatement[] = [];

    if (patch.kind === 'conflict') {
      const conflict = passport.conflicts.find((item) => item.id === patch.resolution.conflictId);
      if (!conflict) return Response.json({ error: 'Conflict not found' }, { status: 404 });
      if (conflict.status !== 'OPEN') return Response.json({ error: '该冲突已经处理' }, { status: 409 });
      const fact = passport.facts.find((item) => item.key === conflict.factKey);
      if (!fact) return Response.json({ error: '冲突对应的商品属性不存在' }, { status: 409 });

      let selectedCandidate: ConflictCandidate | undefined;
      let value: FactValue;
      let unit: string | null;
      let confidence: number;
      let sourceKind: EvidenceSourceKind;
      if (patch.resolution.candidateId) {
        selectedCandidate = conflict.candidates.find((candidate) => candidate.id === patch.resolution.candidateId);
        if (!selectedCandidate) return Response.json({ error: 'Conflict candidate not found' }, { status: 404 });
        value = selectedCandidate.value;
        unit = selectedCandidate.unit ?? null;
        confidence = selectedCandidate.confidence ?? 1;
        sourceKind = selectedCandidate.sourceKind ?? fact.sourceKind;
      } else {
        value = patch.resolution.manualValue as FactValue;
        unit = patch.resolution.unit;
        confidence = 1;
        sourceKind = 'USER_INPUT';
      }

      writes.push(DB.prepare(
        `UPDATE product_facts
         SET value_json = ?, unit = ?, status = 'CONFIRMED', confidence = ?, source_kind = ?, updated_at = ?
         WHERE id = ? AND passport_id = ?`,
      ).bind(JSON.stringify(value), unit, confidence, sourceKind, now, fact.id, passport.id));
      writes.push(DB.prepare(
        `UPDATE fact_conflicts
         SET status = 'RESOLVED', resolution_json = ?, updated_at = ?
         WHERE id = ? AND passport_id = ? AND status = 'OPEN'`,
      ).bind(JSON.stringify({
        selectedCandidateId: selectedCandidate?.id ?? null,
        resolvedValue: value,
        resolvedBy: 'user',
        note: selectedCandidate ? `采用${selectedCandidate.sourceLabel}的候选值` : '商家手动填写',
        resolvedAt: now,
      }), now, conflict.id, passport.id));

      if (!selectedCandidate) {
        const evidenceId = `evidence_${crypto.randomUUID()}`;
        writes.push(
          DB.prepare(
            `INSERT INTO evidence_records
             (id, task_id, file_id, source_kind, locator_json, excerpt, content_hash, created_at)
             VALUES (?, ?, NULL, 'USER_INPUT', ?, ?, NULL, ?)`,
          ).bind(
            evidenceId,
            taskId,
            JSON.stringify({ kind: 'FORM_FIELD', path: `passport.conflict.${conflict.id}` }),
            evidenceExcerpt(value),
            now,
          ),
          DB.prepare(
            `INSERT OR IGNORE INTO fact_evidence_links (fact_id, evidence_id, relation)
             VALUES (?, ?, 'supports')`,
          ).bind(fact.id, evidenceId),
        );
      }
      if (fact.key === 'product.name' && typeof value === 'string') {
        writes.push(DB.prepare('UPDATE tasks SET product_name = ?, updated_at = ? WHERE id = ?')
          .bind(value, now, taskId));
      }
      writes.push(DB.prepare(
        'UPDATE product_passports SET version = version + 1, updated_at = ? WHERE id = ?',
      ).bind(now, passport.id));
      await DB.batch(writes);
      return Response.json({ passport: await getProductPassport(DB, taskId) });
    }

    const existingByKey = new Map<string, ProductFact>(passport.facts.map((fact) => [fact.key, fact]));

    for (const factPatch of patch.facts) {
      const existing = existingByKey.get(factPatch.key);
      const factId = existing?.id ?? `fact_${crypto.randomUUID()}`;
      const evidenceId = `evidence_${crypto.randomUUID()}`;

      if (existing) {
        writes.push(DB.prepare(
          `UPDATE product_facts
           SET label = ?, value_json = ?, unit = ?, status = ?, confidence = ?, source_kind = 'USER_INPUT', updated_at = ?
           WHERE id = ? AND passport_id = ?`,
        ).bind(factPatch.label, JSON.stringify(factPatch.value), factPatch.unit, factPatch.status, factPatch.confidence, now, factId, passport.id));
      } else {
        writes.push(DB.prepare(
          `INSERT INTO product_facts
           (id, passport_id, variant_id, fact_key, label, value_json, unit, status, confidence, source_kind, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'USER_INPUT', ?, ?)`,
        ).bind(factId, passport.id, factPatch.key, factPatch.label, JSON.stringify(factPatch.value), factPatch.unit, factPatch.status, factPatch.confidence, now, now));
      }

      writes.push(
        DB.prepare(
          `INSERT INTO evidence_records
           (id, task_id, file_id, source_kind, locator_json, excerpt, content_hash, created_at)
           VALUES (?, ?, NULL, 'USER_INPUT', ?, ?, NULL, ?)`,
        ).bind(
          evidenceId,
          taskId,
          JSON.stringify({ kind: 'FORM_FIELD', path: `passport.manual.${factPatch.key}` }),
          evidenceExcerpt(factPatch.value),
          now,
        ),
        DB.prepare(
          `INSERT INTO fact_evidence_links (fact_id, evidence_id, relation)
           VALUES (?, ?, 'supports')`,
        ).bind(factId, evidenceId),
      );

      if (factPatch.key === 'product.name' && typeof factPatch.value === 'string') {
        writes.push(DB.prepare('UPDATE tasks SET product_name = ?, updated_at = ? WHERE id = ?')
          .bind(factPatch.value, now, taskId));
      }
    }

    writes.push(DB.prepare(
      'UPDATE product_passports SET version = version + 1, updated_at = ? WHERE id = ?',
    ).bind(now, passport.id));
    await DB.batch(writes);

    return Response.json({ passport: await getProductPassport(DB, taskId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update product passport';
    const clientError = /facts must|每次需|事实字段|缺失状态|请求内容|conflictResolution|冲突记录|请选择|冲突候选值|人工确认值|单位过长/.test(message);
    const notFound = message === 'Task not found' || message === 'Conflict not found' || message === 'Conflict candidate not found';
    return Response.json({ error: message }, { status: notFound ? 404 : clientError ? 400 : 500 });
  }
}
