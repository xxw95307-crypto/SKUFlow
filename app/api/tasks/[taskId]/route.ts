import { ensureSchema, getBindings } from '@/db/client';
import type { PlatformId } from '@/lib/domain/platform';
import { isTaskStatus, type TaskEvent, type TaskFile, type TaskFileStatus, type TaskSnapshot, type TaskStatus } from '@/lib/domain/task';
import { assertTransition } from '@/lib/workflow/task-machine';

export const dynamic = 'force-dynamic';

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

async function getTask(taskId: string): Promise<TaskSnapshot | null> {
  const { DB } = getBindings();
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
    ).bind(taskId).all<{ id: number; from_status: TaskStatus | null; to_status: TaskStatus; actor: TaskEvent['actor']; note: string | null; created_at: string }>(),
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

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const task = await getTask(taskId);
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    return Response.json({ task });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to load task' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const body = await request.json() as { status?: unknown; note?: unknown };
    if (!isTaskStatus(body.status)) return Response.json({ error: 'Invalid target status' }, { status: 400 });

    const { DB } = getBindings();
    const current = await DB.prepare('SELECT status FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<{ status: TaskStatus }>();
    if (!current) return Response.json({ error: 'Task not found' }, { status: 404 });

    assertTransition(current.status, body.status);
    const now = new Date().toISOString();
    const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;
    await DB.batch([
      DB.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
        .bind(body.status, now, taskId),
      DB.prepare(
        `INSERT INTO task_events (task_id, from_status, to_status, actor, note, created_at)
         VALUES (?, ?, ?, 'user', ?, ?)`,
      ).bind(taskId, current.status, body.status, note, now),
    ]);

    return Response.json({ task: await getTask(taskId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update task';
    const invalidTransition = message.startsWith('Invalid task transition');
    return Response.json({ error: message }, { status: invalidTransition ? 409 : 500 });
  }
}
