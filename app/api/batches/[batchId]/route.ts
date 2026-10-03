import { currentAccount, withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { getBatchSummary } from '@/lib/server/batch-store';

export const dynamic = 'force-dynamic';

async function handleGET(_request: Request, context: { params: Promise<{ batchId: string }> }) {
  await ensureSchema();
  const { batchId } = await context.params;
  const batch = await getBatchSummary(getBindings().DB, (await currentAccount())!.id, batchId);
  return batch ? Response.json({ batch }) : Response.json({ error: '批量任务不存在' }, { status: 404 });
}

export const GET = withAuthentication(handleGET);
