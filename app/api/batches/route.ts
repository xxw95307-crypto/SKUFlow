import { currentAccount, withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { groupBatchFolders } from '@/lib/domain/batch-folders';
import { PENDING_PRODUCT_NAME } from '@/lib/domain/task';
import { createInitialProductPassport } from '@/lib/domain/product-passport';
import { prepareInitialPassportWrites } from '@/lib/server/passport-store';
import { validatePlatformTargets, type PlatformTarget } from '@/lib/platforms/market-options';

export const dynamic = 'force-dynamic';

function safeName(name: string): string {
  return name.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(-100) || 'source';
}

async function handleGET() {
  await ensureSchema();
  const { DB } = getBindings();
  const user = (await currentAccount())!;
  const result = await DB.prepare(`SELECT b.id,b.name,b.source_label,b.created_at,
    (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id=b.id) AS item_count
    FROM batch_jobs b WHERE b.user_id=? ORDER BY b.created_at DESC LIMIT 30`).bind(user.id)
    .all<{ id: string; name: string; source_label: string; created_at: string; item_count: number }>();
  return Response.json({ batches: result.results.map((row) => ({ id: row.id, name: row.name, sourceLabel: row.source_label, createdAt: row.created_at, itemCount: row.item_count })) });
}

async function handlePOST(request: Request) {
  const storedKeys: string[] = [];
  try {
    await ensureSchema();
    const { DB, UPLOADS } = getBindings();
    const user = (await currentAccount())!;
    const form = await request.formData();
    const files = form.getAll('files').filter((value): value is File => value instanceof File);
    const paths = JSON.parse(String(form.get('paths') || '[]')) as unknown;
    if (!Array.isArray(paths) || paths.length !== files.length || paths.some((path) => typeof path !== 'string')) {
      return Response.json({ error: '文件夹路径与上传文件不匹配' }, { status: 400 });
    }
    const folder = groupBatchFolders(files.map((file, index) => ({ index, name: file.name, relativePath: paths[index], size: file.size })));
    const rawTargets = JSON.parse(String(form.get('targets') || '[]')) as unknown;
    if (!Array.isArray(rawTargets) || rawTargets.some((target) => !target || typeof target !== 'object' || typeof target.platformId !== 'string' || typeof target.market !== 'string')) {
      return Response.json({ error: '平台站点选择无效' }, { status: 400 });
    }
    const targets = validatePlatformTargets(rawTargets as PlatformTarget[]);
    if (targets.length > 4) return Response.json({ error: '批量任务一次最多选择 4 个平台站点组合' }, { status: 400 });
    const name = String(form.get('name') || folder.root).trim().slice(0, 80) || folder.root;
    const now = new Date().toISOString();
    const batchId = `batch_${crypto.randomUUID()}`;
    const platforms = [...new Set(targets.map((target) => target.platformId))];
    const markets = [...new Set(targets.map((target) => target.market))];
    const writes: D1PreparedStatement[] = [DB.prepare('INSERT INTO batch_jobs (id,user_id,name,source_label,targets_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .bind(batchId, user.id, name, folder.root, JSON.stringify(targets), now, now)];

    for (const [position, product] of folder.products.entries()) {
      const taskId = `task_${crypto.randomUUID()}`;
      const conversationId = `conversation_${crypto.randomUUID()}`;
      const passport = createInitialProductPassport({ taskId, platforms, markets, targets, now });
      const storedFiles: Array<{ id: string; name: string; key: string; type: string; size: number }> = [];
      for (const item of product.files) {
        const file = files[item.index];
        const id = `file_${crypto.randomUUID()}`;
        const key = `tasks/${taskId}/source/${id}-${safeName(file.name)}`;
        const type = file.type || 'application/octet-stream';
        await UPLOADS.put(key, file.stream(), { httpMetadata: { contentType: type }, customMetadata: { taskId, fileId: id, originalName: file.name } });
        storedKeys.push(key);
        storedFiles.push({ id, name: file.name, key, type, size: file.size });
      }
      writes.push(
        DB.prepare('INSERT INTO tasks (id,product_name,status,markets_json,platforms_json,created_at,updated_at) VALUES (?, ?,\'CREATED\',?,?,?,?)')
          .bind(taskId, PENDING_PRODUCT_NAME, JSON.stringify(markets), JSON.stringify(platforms), now, now),
        DB.prepare("INSERT INTO resource_owners (kind,resource_id,user_id) VALUES ('task',?,?)").bind(taskId, user.id),
        DB.prepare("INSERT INTO task_events (task_id,from_status,to_status,actor,note,created_at) VALUES (?,NULL,'CREATED','user',?,?)")
          .bind(taskId, `来自批量导入：${product.name}`, now),
        ...storedFiles.map((file) => DB.prepare('INSERT INTO task_files (id,task_id,filename,object_key,content_type,size,status,created_at) VALUES (?,?,?,?,?, ?,\'STORED\',?)')
          .bind(file.id, taskId, file.name, file.key, file.type, file.size, now)),
        ...prepareInitialPassportWrites(DB, passport),
        DB.prepare("INSERT INTO agent_conversations (id,task_id,title,status,messages_json,model_history_json,tool_runs_json,selected_assets_json,created_at,updated_at) VALUES (?,?,?,'ACTIVE',?,'[]','[]','[]',?,?)")
          .bind(conversationId, taskId, product.name, JSON.stringify([{ id: `message_${crypto.randomUUID()}`, role: 'agent', text: `已导入 ${product.name} 的资料。请在此确认冲突、审核 Listing 和选择素材。`, meta: '批量任务' }]), now, now),
        DB.prepare("INSERT INTO resource_owners (kind,resource_id,user_id) VALUES ('conversation',?,?)").bind(conversationId, user.id),
        DB.prepare('INSERT INTO batch_items (batch_id,task_id,conversation_id,row_number,sku,product_name) VALUES (?,?,?,?,?,?)')
          .bind(batchId, taskId, conversationId, position + 1, product.name, product.name),
      );
    }
    await DB.batch(writes);
    return Response.json({ id: batchId, name, count: folder.products.length }, { status: 201 });
  } catch (error) {
    if (storedKeys.length) {
      const { UPLOADS } = getBindings();
      await Promise.allSettled(storedKeys.map((key) => UPLOADS.delete(key)));
    }
    const message = error instanceof Error ? error.message : '批量任务创建失败';
    return Response.json({ error: message }, { status: /文件|商品|平台|站点|资料|表格|批|选择|不支持|超过|缺少/.test(message) ? 400 : 500 });
  }
}

export const GET = withAuthentication(handleGET);
export const POST = withAuthentication(handlePOST);
