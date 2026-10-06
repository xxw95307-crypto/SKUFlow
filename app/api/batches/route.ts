import { currentAccount, withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { groupBatchFolders, uploadedFilename } from '@/lib/domain/batch-folders';
import { PENDING_PRODUCT_NAME } from '@/lib/domain/task';
import { createInitialProductPassport } from '@/lib/domain/product-passport';
import { validatePlatformTargets, type PlatformTarget } from '@/lib/platforms/market-options';

export const dynamic = 'force-dynamic';

function safeName(name: string): string {
  return name.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(-100) || 'source';
}

function prepareJsonInsert(DB: D1Database, table: string, columns: readonly string[], rows: readonly Record<string, unknown>[]): D1PreparedStatement {
  const values = columns.map((column) => `json_extract(value, '$.${column}')`).join(',');
  return DB.prepare(`INSERT INTO ${table} (${columns.join(',')}) SELECT ${values} FROM json_each(?)`).bind(JSON.stringify(rows));
}

async function handleGET() {
  try {
    await ensureSchema();
    const { DB } = getBindings();
    const user = (await currentAccount())!;
    const result = await DB.prepare(`SELECT b.id,b.name,b.source_label,b.created_at,
      (SELECT COUNT(*) FROM batch_items i WHERE i.batch_id=b.id) AS item_count
      FROM batch_jobs b WHERE b.user_id=? ORDER BY b.created_at DESC LIMIT 30`).bind(user.id)
      .all<{ id: string; name: string; source_label: string; created_at: string; item_count: number }>();
    return Response.json({ batches: result.results.map((row) => ({ id: row.id, name: row.name, sourceLabel: row.source_label, createdAt: row.created_at, itemCount: row.item_count })) });
  } catch (error) {
    console.error('Batch list failed', error);
    return Response.json({ error: '批量任务读取失败，请重新加载' }, { status: 500 });
  }
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
    const folder = groupBatchFolders(files.map((file, index) => ({
      index, name: uploadedFilename(file.name, paths[index]), relativePath: paths[index], size: file.size,
    })));
    const rawTargets = JSON.parse(String(form.get('targets') || '[]')) as unknown;
    if (!Array.isArray(rawTargets) || rawTargets.some((target) => !target || typeof target !== 'object' || typeof target.platformId !== 'string' || typeof target.market !== 'string')) {
      return Response.json({ error: '平台站点选择无效' }, { status: 400 });
    }
    const targets = validatePlatformTargets(rawTargets as PlatformTarget[]);
    const name = String(form.get('name') || folder.root).trim().slice(0, 80) || folder.root;
    const now = new Date().toISOString();
    const batchId = `batch_${crypto.randomUUID()}`;
    const platforms = [...new Set(targets.map((target) => target.platformId))];
    const markets = [...new Set(targets.map((target) => target.market))];
    const jobColumns = (await DB.prepare('PRAGMA table_info(batch_jobs)').all<{ name: string }>()).results.map((column) => column.name);
    const legacyColumns = jobColumns.includes('source_filename') && jobColumns.includes('source_sheet');
    const jobWrite = legacyColumns
      ? DB.prepare('INSERT INTO batch_jobs (id,user_id,name,source_label,source_filename,source_sheet,targets_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(batchId, user.id, name, folder.root, folder.root, '', JSON.stringify(targets), now, now)
      : DB.prepare('INSERT INTO batch_jobs (id,user_id,name,source_label,targets_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind(batchId, user.id, name, folder.root, JSON.stringify(targets), now, now);
    const taskRows: Record<string, unknown>[] = [];
    const ownerRows: Record<string, unknown>[] = [];
    const eventRows: Record<string, unknown>[] = [];
    const fileRows: Record<string, unknown>[] = [];
    const passportRows: Record<string, unknown>[] = [];
    const draftRows: Record<string, unknown>[] = [];
    const conversationRows: Record<string, unknown>[] = [];
    const itemRows: Record<string, unknown>[] = [];

    for (const [position, product] of folder.products.entries()) {
      const taskId = `task_${crypto.randomUUID()}`;
      const conversationId = `conversation_${crypto.randomUUID()}`;
      const passport = createInitialProductPassport({ taskId, platforms, markets, targets, now });
      const storedFiles: Array<{ id: string; name: string; key: string; type: string; size: number }> = [];
      for (const item of product.files) {
        const file = files[item.index];
        const id = `file_${crypto.randomUUID()}`;
        const key = `tasks/${taskId}/source/${id}-${safeName(item.name)}`;
        const type = file.type || 'application/octet-stream';
        await UPLOADS.put(key, file.stream(), { httpMetadata: { contentType: type }, customMetadata: { taskId, fileId: id, originalName: item.name } });
        storedKeys.push(key);
        storedFiles.push({ id, name: item.name, key, type, size: file.size });
      }
      taskRows.push({ id: taskId, product_name: PENDING_PRODUCT_NAME, status: 'CREATED', markets_json: JSON.stringify(markets), platforms_json: JSON.stringify(platforms), created_at: now, updated_at: now });
      ownerRows.push({ kind: 'task', resource_id: taskId, user_id: user.id }, { kind: 'conversation', resource_id: conversationId, user_id: user.id });
      eventRows.push({ task_id: taskId, from_status: null, to_status: 'CREATED', actor: 'user', note: `来自批量导入：${product.name}`, created_at: now });
      fileRows.push(...storedFiles.map((file) => ({ id: file.id, task_id: taskId, filename: file.name, object_key: file.key, content_type: file.type, size: file.size, status: 'STORED', created_at: now })));
      passportRows.push({ id: passport.id, task_id: taskId, version: passport.version, status: passport.status, locked_at: passport.lockedAt, created_at: now, updated_at: now });
      draftRows.push(...passport.platformDrafts.map((draft) => ({ id: draft.id, task_id: taskId, passport_id: passport.id, platform_id: draft.platformId, market: draft.market, locale: draft.locale, category_id: draft.categoryId, status: draft.status, schema_version: draft.schemaVersion, payload_json: JSON.stringify(draft.payload), validation_json: JSON.stringify(draft.validationIssues), created_at: now, updated_at: now })));
      conversationRows.push({ id: conversationId, task_id: taskId, title: product.name, status: 'ACTIVE', messages_json: JSON.stringify([{ id: `message_${crypto.randomUUID()}`, role: 'agent', text: `已导入 ${product.name} 的资料。请在此确认冲突、审核 Listing 和选择素材。`, meta: '批量任务' }]), model_history_json: '[]', tool_runs_json: '[]', selected_assets_json: '[]', created_at: now, updated_at: now });
      itemRows.push({ batch_id: batchId, task_id: taskId, conversation_id: conversationId, row_number: position + 1, sku: product.name, product_name: product.name });
    }
    await DB.batch([
      jobWrite,
      prepareJsonInsert(DB, 'tasks', ['id','product_name','status','markets_json','platforms_json','created_at','updated_at'], taskRows),
      prepareJsonInsert(DB, 'task_events', ['task_id','from_status','to_status','actor','note','created_at'], eventRows),
      prepareJsonInsert(DB, 'task_files', ['id','task_id','filename','object_key','content_type','size','status','created_at'], fileRows),
      prepareJsonInsert(DB, 'product_passports', ['id','task_id','version','status','locked_at','created_at','updated_at'], passportRows),
      prepareJsonInsert(DB, 'platform_drafts', ['id','task_id','passport_id','platform_id','market','locale','category_id','status','schema_version','payload_json','validation_json','created_at','updated_at'], draftRows),
      prepareJsonInsert(DB, 'agent_conversations', ['id','task_id','title','status','messages_json','model_history_json','tool_runs_json','selected_assets_json','created_at','updated_at'], conversationRows),
      prepareJsonInsert(DB, 'resource_owners', ['kind','resource_id','user_id'], ownerRows),
      prepareJsonInsert(DB, 'batch_items', ['batch_id','task_id','conversation_id','row_number','sku','product_name'], itemRows),
    ]);
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
