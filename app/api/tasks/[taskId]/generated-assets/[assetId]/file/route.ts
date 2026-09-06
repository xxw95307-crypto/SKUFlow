import { ensureSchema, getBindings } from '@/db/client';

export const dynamic = 'force-dynamic';

interface AssetFileRow {
  object_key: string | null;
  content_type: string | null;
  status: string;
}

export async function GET(_request: Request, context: { params: Promise<{ taskId: string; assetId: string }> }) {
  try {
    await ensureSchema();
    const { taskId, assetId } = await context.params;
    if (!/^task_[a-zA-Z0-9-]+$/.test(taskId) || !/^asset_[a-zA-Z0-9-]+$/.test(assetId)) {
      return Response.json({ error: 'Invalid asset reference' }, { status: 400 });
    }
    const { DB, UPLOADS } = getBindings();
    const asset = await DB.prepare(
      `SELECT object_key, content_type, status FROM generated_assets
       WHERE task_id = ? AND id = ?`,
    ).bind(taskId, assetId).first<AssetFileRow>();
    if (!asset || asset.status !== 'COMPLETED' || !asset.object_key) return Response.json({ error: 'Asset not found' }, { status: 404 });
    const object = await UPLOADS.get(asset.object_key);
    if (!object?.body) return Response.json({ error: 'Asset content not found' }, { status: 404 });
    return new Response(object.body, {
      headers: {
        'content-type': asset.content_type || 'image/png',
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to load asset' }, { status: 500 });
  }
}
