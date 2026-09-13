import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';

export const dynamic = 'force-dynamic';

interface FileRow {
  object_key: string;
  content_type: string;
}

async function handleGET(_request: Request, context: { params: Promise<{ taskId: string; fileId: string }> }) {
  try {
    await ensureSchema();
    const { taskId, fileId } = await context.params;
    if (!/^task_[a-zA-Z0-9-]+$/.test(taskId) || !/^file_[a-zA-Z0-9-]+$/.test(fileId)) {
      return Response.json({ error: 'Invalid file reference' }, { status: 400 });
    }
    const { DB, UPLOADS } = getBindings();
    const file = await DB.prepare(
      'SELECT object_key, content_type FROM task_files WHERE task_id = ? AND id = ?',
    ).bind(taskId, fileId).first<FileRow>();
    if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
    const object = await UPLOADS.get(file.object_key);
    if (!object?.body) return Response.json({ error: 'File content not found' }, { status: 404 });
    return new Response(object.body, {
      headers: {
        'content-type': file.content_type || 'application/octet-stream',
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to load file' }, { status: 500 });
  }
}

export const GET = withAuthentication(handleGET);
