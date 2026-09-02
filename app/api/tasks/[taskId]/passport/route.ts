import { ensureSchema, getBindings } from '@/db/client';
import { isFactStatus, type FactStatus, type FactValue, type ProductFact } from '@/lib/domain/product-passport';
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

function parseFactPatches(body: unknown): FactPatch[] {
  if (!body || typeof body !== 'object' || !('facts' in body) || !Array.isArray(body.facts)) {
    throw new Error('facts must be an array');
  }
  if (body.facts.length === 0 || body.facts.length > 20) throw new Error('每次需更新 1–20 个事实字段');

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
      throw new Error(`事实字段 confidence 需为 0–1：${key}`);
    }

    return { key, label, value, unit: unit || null, status, confidence };
  });
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
    const patches = parseFactPatches(await request.json());
    const { DB } = getBindings();
    const passport = await getProductPassport(DB, taskId);
    if (!passport) return Response.json({ error: 'Task not found' }, { status: 404 });
    if (passport.status === 'LOCKED') return Response.json({ error: 'Product passport is locked' }, { status: 409 });

    const existingByKey = new Map<string, ProductFact>(passport.facts.map((fact) => [fact.key, fact]));
    const now = new Date().toISOString();
    const writes: D1PreparedStatement[] = [];

    for (const patch of patches) {
      const existing = existingByKey.get(patch.key);
      const factId = existing?.id ?? `fact_${crypto.randomUUID()}`;
      const evidenceId = `evidence_${crypto.randomUUID()}`;

      if (existing) {
        writes.push(DB.prepare(
          `UPDATE product_facts
           SET label = ?, value_json = ?, unit = ?, status = ?, confidence = ?, source_kind = 'USER_INPUT', updated_at = ?
           WHERE id = ? AND passport_id = ?`,
        ).bind(patch.label, JSON.stringify(patch.value), patch.unit, patch.status, patch.confidence, now, factId, passport.id));
      } else {
        writes.push(DB.prepare(
          `INSERT INTO product_facts
           (id, passport_id, variant_id, fact_key, label, value_json, unit, status, confidence, source_kind, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'USER_INPUT', ?, ?)`,
        ).bind(factId, passport.id, patch.key, patch.label, JSON.stringify(patch.value), patch.unit, patch.status, patch.confidence, now, now));
      }

      writes.push(
        DB.prepare(
          `INSERT INTO evidence_records
           (id, task_id, file_id, source_kind, locator_json, excerpt, content_hash, created_at)
           VALUES (?, ?, NULL, 'USER_INPUT', ?, ?, NULL, ?)`,
        ).bind(
          evidenceId,
          taskId,
          JSON.stringify({ kind: 'FORM_FIELD', path: `passport.manual.${patch.key}` }),
          evidenceExcerpt(patch.value),
          now,
        ),
        DB.prepare(
          `INSERT INTO fact_evidence_links (fact_id, evidence_id, relation)
           VALUES (?, ?, 'supports')`,
        ).bind(factId, evidenceId),
      );

      if (patch.key === 'product.name' && typeof patch.value === 'string') {
        writes.push(DB.prepare('UPDATE tasks SET product_name = ?, updated_at = ? WHERE id = ?')
          .bind(patch.value, now, taskId));
      }
    }

    writes.push(DB.prepare(
      'UPDATE product_passports SET version = version + 1, updated_at = ? WHERE id = ?',
    ).bind(now, passport.id));
    await DB.batch(writes);

    return Response.json({ passport: await getProductPassport(DB, taskId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update product passport';
    const clientError = /facts must|每次需|事实字段|缺失状态/.test(message);
    const notFound = message === 'Task not found';
    return Response.json({ error: message }, { status: notFound ? 404 : clientError ? 400 : 500 });
  }
}
