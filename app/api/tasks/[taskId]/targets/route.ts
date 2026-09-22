import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { platformRegistry } from '@/lib/platforms/registry';
import type { PlatformId } from '@/lib/domain/platform';
import type { TaskSnapshot } from '@/lib/domain/task';

export const dynamic = 'force-dynamic';

interface TaskRow {
  id: string;
  product_name: string;
  status: string;
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
    'SELECT id, product_name, status, markets_json, platforms_json, created_at, updated_at FROM tasks WHERE id = ?',
  ).bind(taskId).first<TaskRow>();
  if (!row) return null;
  return {
    id: row.id,
    productName: row.product_name,
    status: row.status as TaskSnapshot['status'],
    markets: parseArray<string>(row.markets_json),
    platforms: parseArray<PlatformId>(row.platforms_json),
    files: [],
    events: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanList(value: unknown, transform: (item: string) => string): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => transform(item.trim()))
    .filter(Boolean))].slice(0, 12);
}

async function handlePUT(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const body = await request.json() as { platforms?: unknown; markets?: unknown };
    const platforms = cleanList(body.platforms, (item) => item.toLowerCase());
    const markets = cleanList(body.markets, (item) => item.toUpperCase());
    if (platforms.length === 0 || markets.length === 0) {
      return Response.json({ error: '平台列表和市场列表都不能为空' }, { status: 400 });
    }
    const knownIds = new Set(platformRegistry.map((profile) => profile.id));
    const invalid = platforms.find((item) => !knownIds.has(item as PlatformId));
    if (invalid) return Response.json({ error: `不支持的平台：${invalid}` }, { status: 400 });
    if (platforms.length * markets.length > 24) {
      return Response.json({ error: '平台与市场组合不能超过 24 个' }, { status: 400 });
    }

    const { DB } = getBindings();
    const current = await DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(taskId).first<{ id: string }>();
    if (!current) return Response.json({ error: 'Task not found' }, { status: 404 });

    const published = await DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_drafts WHERE task_id = ? AND status = 'DRAFT_CREATED'",
    ).bind(taskId).first<{ count: number }>();
    if ((published?.count ?? 0) > 0) {
      return Response.json({ error: '已有平台测试草稿发布，任务目标不可再更改' }, { status: 409 });
    }

    const now = new Date().toISOString();
    // 更新目标并作废全部未发布的审校稿：目标变了，旧稿字段结构不再可信，
    // 由编排器在下一轮根据新的 platform × market 组合重新生成。
    await DB.batch([
      DB.prepare('UPDATE tasks SET markets_json = ?, platforms_json = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(markets), JSON.stringify(platforms), now, taskId),
      DB.prepare('DELETE FROM platform_drafts WHERE task_id = ?').bind(taskId),
    ]);

    return Response.json({ task: await getTask(taskId), invalidatedDrafts: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to update task targets' },
      { status: 500 },
    );
  }
}

export const PUT = withAuthentication(handlePUT);
