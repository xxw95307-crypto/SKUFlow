import { currentAccount, withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';

export const dynamic = 'force-dynamic';

async function handlePATCH(request: Request, context: { params: Promise<{ batchId: string; taskId: string }> }) {
  await ensureSchema();
  const { batchId, taskId } = await context.params;
  const account = (await currentAccount())!;
  const body = await request.json().catch(() => null) as { error?: unknown } | null;
  if (!body || (body.error !== null && (typeof body.error !== 'string' || body.error.length > 500))) {
    return Response.json({ error: '错误记录格式无效' }, { status: 400 });
  }
  const result = await getBindings().DB.prepare(`UPDATE batch_items SET last_error=? WHERE batch_id=? AND task_id=?
    AND EXISTS (SELECT 1 FROM batch_jobs WHERE id=? AND user_id=?)`)
    .bind(body.error, batchId, taskId, batchId, account.id).run();
  return result.meta.changes ? Response.json({ ok: true }) : Response.json({ error: '商品不属于当前批次' }, { status: 404 });
}

export const PATCH = withAuthentication(handlePATCH);
