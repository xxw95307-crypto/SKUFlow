import type { GeneratedAsset, GeneratedAssetKind, GeneratedAssetStatus } from '../domain/generated-asset';

interface GeneratedAssetRow {
  id: string;
  task_id: string;
  source_file_id: string;
  batch_id: string;
  asset_kind: GeneratedAssetKind;
  title: string;
  note: string;
  model: string;
  status: GeneratedAssetStatus;
  width: number | null;
  height: number | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

const columns = `id, task_id, source_file_id, batch_id, asset_kind, title, note, model,
  status, width, height, error, created_at, completed_at`;

function mapAsset(row: GeneratedAssetRow): GeneratedAsset {
  return {
    id: row.id,
    taskId: row.task_id,
    sourceFileId: row.source_file_id,
    batchId: row.batch_id,
    kind: row.asset_kind,
    title: row.title,
    note: row.note,
    model: row.model,
    status: row.status,
    width: row.width,
    height: row.height,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    imageUrl: row.status === 'COMPLETED' ? `/api/tasks/${row.task_id}/generated-assets/${row.id}/file` : null,
  };
}

export async function listLatestGeneratedAssets(DB: D1Database, taskId: string): Promise<GeneratedAsset[]> {
  const latest = await DB.prepare(
    `SELECT batch_id FROM generated_assets
     WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(taskId).first<{ batch_id: string }>();
  if (!latest) return [];
  const result = await DB.prepare(
    `SELECT ${columns} FROM generated_assets
     WHERE task_id = ? AND batch_id = ? ORDER BY created_at ASC`,
  ).bind(taskId, latest.batch_id).all<GeneratedAssetRow>();
  return result.results.map(mapAsset);
}

export async function listGeneratedAssetHistory(DB: D1Database, taskId: string): Promise<GeneratedAsset[][]> {
  const result = await DB.prepare(
    `SELECT ${columns} FROM generated_assets
     WHERE task_id = ? AND asset_kind != 'VIDEO' AND status = 'COMPLETED'
     ORDER BY created_at ASC LIMIT 180`,
  ).bind(taskId).all<GeneratedAssetRow>();
  const batches = new Map<string, GeneratedAsset[]>();
  for (const row of result.results) {
    const batch = batches.get(row.batch_id) ?? [];
    batch.push(mapAsset(row));
    batches.set(row.batch_id, batch);
  }
  return [...batches.values()];
}

export async function countGeneratedAssets(DB: D1Database, taskId: string): Promise<number> {
  const latest = await DB.prepare(
    `SELECT batch_id FROM generated_assets
     WHERE task_id = ? AND status = 'COMPLETED' ORDER BY created_at DESC LIMIT 1`,
  ).bind(taskId).first<{ batch_id: string }>();
  if (!latest) return 0;
  const result = await DB.prepare(
    `SELECT COUNT(*) AS count FROM generated_assets
     WHERE task_id = ? AND batch_id = ? AND status = 'COMPLETED'`,
  ).bind(taskId, latest.batch_id).first<{ count: number }>();
  return Number(result?.count ?? 0);
}

export function prepareGeneratedAssetInsert(
  DB: D1Database,
  input: {
    id: string;
    taskId: string;
    sourceFileId: string;
    batchId: string;
    kind: GeneratedAssetKind;
    title: string;
    note: string;
    prompt: string;
    objectKey: string | null;
    contentType: string | null;
    model: string;
    status: GeneratedAssetStatus;
    width: number | null;
    height: number | null;
    error: string | null;
    createdAt: string;
    completedAt: string;
  },
): D1PreparedStatement {
  return DB.prepare(
    `INSERT INTO generated_assets
     (id, task_id, source_file_id, batch_id, asset_kind, title, note, prompt, object_key,
      content_type, provider, model, status, width, height, error, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BAILIAN', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id, input.taskId, input.sourceFileId, input.batchId, input.kind, input.title, input.note,
    input.prompt, input.objectKey, input.contentType, input.model, input.status, input.width,
    input.height, input.error?.slice(0, 500) ?? null, input.createdAt, input.completedAt,
  );
}
