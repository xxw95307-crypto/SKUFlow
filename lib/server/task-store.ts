import type { PlatformId } from '../domain/platform';
import type { TaskEvent, TaskFile, TaskFileStatus, TaskSnapshot, TaskStatus } from '../domain/task';

interface TaskRow {
  id: string;
  product_name: string;
  status: TaskStatus;
  markets_json: string;
  platforms_json: string;
  created_at: string;
  updated_at: string;
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export async function getTaskSnapshot(DB: D1Database, taskId: string): Promise<TaskSnapshot | null> {
  const row = await DB.prepare(
    `SELECT id, product_name, status, markets_json, platforms_json, created_at, updated_at
     FROM tasks WHERE id = ?`,
  ).bind(taskId).first<TaskRow>();
  if (!row) return null;

  const [fileResult, eventResult] = await Promise.all([
    DB.prepare(
      `SELECT id, filename, content_type, size, status
       FROM task_files WHERE task_id = ? ORDER BY created_at ASC`,
    ).bind(taskId).all<{ id: string; filename: string; content_type: string; size: number; status: TaskFileStatus }>(),
    DB.prepare(
      `SELECT id, from_status, to_status, actor, note, created_at
       FROM task_events WHERE task_id = ? ORDER BY id ASC`,
    ).bind(taskId).all<{
      id: number;
      from_status: TaskStatus | null;
      to_status: TaskStatus;
      actor: TaskEvent['actor'];
      note: string | null;
      created_at: string;
    }>(),
  ]);

  const files: TaskFile[] = fileResult.results.map((file) => ({
    id: file.id,
    name: file.filename,
    contentType: file.content_type,
    size: file.size,
    status: file.status,
  }));
  const events: TaskEvent[] = eventResult.results.map((event) => ({
    id: event.id,
    fromStatus: event.from_status,
    toStatus: event.to_status,
    actor: event.actor,
    note: event.note,
    createdAt: event.created_at,
  }));

  return {
    id: row.id,
    productName: row.product_name,
    status: row.status,
    markets: parseArray<string>(row.markets_json),
    platforms: parseArray<PlatformId>(row.platforms_json),
    files,
    events,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function prepareTaskTransition(
  DB: D1Database,
  input: {
    taskId: string;
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
    actor: TaskEvent['actor'];
    note: string;
    now: string;
  },
): D1PreparedStatement[] {
  return [
    DB.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .bind(input.toStatus, input.now, input.taskId, input.fromStatus),
    DB.prepare(
      `INSERT INTO task_events (task_id, from_status, to_status, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(input.taskId, input.fromStatus, input.toStatus, input.actor, input.note.slice(0, 500), input.now),
  ];
}
