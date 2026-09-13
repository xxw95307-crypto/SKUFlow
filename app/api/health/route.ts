import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';

export const dynamic = 'force-dynamic';

async function handleGET() {
  try {
    await ensureSchema();
    const { DB, UPLOADS } = getBindings();
    const database = await DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    const bucket = await UPLOADS.list({ limit: 1 });

    return Response.json({
      ok: database?.ok === 1,
      service: 'skuflow-ai',
      storage: { d1: 'ready', r2: bucket.truncated ? 'ready' : 'ready' },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown health check error' },
      { status: 503 },
    );
  }
}

export const GET = withAuthentication(handleGET);
