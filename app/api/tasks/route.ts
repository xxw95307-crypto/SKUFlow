import { ensureSchema, getBindings } from '@/db/client';
import { inferIntakeTargets } from '@/lib/agents/intake-targets';
import type { PlatformId } from '@/lib/domain/platform';
import { createInitialProductPassport } from '@/lib/domain/product-passport';
import { PENDING_PRODUCT_NAME, type TaskFile, type TaskSnapshot, type TaskStatus } from '@/lib/domain/task';
import { platformRegistry } from '@/lib/platforms/registry';
import { prepareInitialPassportWrites } from '@/lib/server/passport-store';

export const dynamic = 'force-dynamic';

const MAX_FILE_COUNT = 12;
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MAX_TOTAL_SIZE = 40 * 1024 * 1024;
const allowedExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'pdf', 'xlsx', 'xls', 'csv', 'txt', 'docx']);
const platformIds = new Set(platformRegistry.map((platform) => platform.id));

interface TaskRow {
  id: string;
  product_name: string;
  status: TaskStatus;
  markets_json: string;
  platforms_json: string;
  created_at: string;
  updated_at: string;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function mapTaskRow(row: TaskRow, files: TaskFile[] = []): TaskSnapshot {
  return {
    id: row.id,
    productName: row.product_name,
    status: row.status,
    markets: parseJsonArray<string>(row.markets_json),
    platforms: parseJsonArray<PlatformId>(row.platforms_json),
    files,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStringArray(value: FormDataEntryValue | null, field: string): string[] {
  if (typeof value !== 'string') throw new Error(`${field} is required`);
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be a string array`);
  }
  return parsed;
}

function safeFileName(name: string): string {
  const normalized = name.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-');
  return normalized.slice(-120) || 'source-file';
}

function validateFile(file: File): void {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!allowedExtensions.has(extension)) throw new Error(`不支持的文件类型：${file.name}`);
  if (file.size <= 0) throw new Error(`文件为空：${file.name}`);
  if (file.size > MAX_FILE_SIZE) throw new Error(`单个文件不能超过 15 MB：${file.name}`);
}

export async function GET() {
  try {
    await ensureSchema();
    const { DB } = getBindings();
    const result = await DB.prepare(
      `SELECT id, product_name, status, markets_json, platforms_json, created_at, updated_at
       FROM tasks ORDER BY updated_at DESC LIMIT 20`,
    ).all<TaskRow>();

    return Response.json({ tasks: result.results.map((row) => mapTaskRow(row)) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to list tasks' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const storedObjectKeys: string[] = [];

  try {
    await ensureSchema();
    const { DB, UPLOADS } = getBindings();
    const form = await request.formData();
    const requestText = typeof form.get('request') === 'string' ? String(form.get('request')).slice(0, 4_000) : '';
    const inferredTargets = inferIntakeTargets(requestText);
    const marketField = form.get('markets');
    const platformField = form.get('platforms');
    const markets = marketField === null ? inferredTargets.markets : parseStringArray(marketField, 'markets');
    const platforms = (platformField === null ? inferredTargets.platforms : parseStringArray(platformField, 'platforms')) as PlatformId[];
    const files = form.getAll('files').filter((entry): entry is File => entry instanceof File);

    if (markets.length === 0 || markets.length > 8) throw new Error('请选择 1–8 个目标市场');
    if (platforms.length === 0 || platforms.length > platformRegistry.length) throw new Error('请至少选择一个目标平台');
    if (platforms.some((id) => !platformIds.has(id))) throw new Error('包含未知平台');
    if (platforms.length * markets.length > 24) throw new Error('平台与市场组合不能超过 24 个');
    if (files.length === 0 || files.length > MAX_FILE_COUNT) throw new Error(`请上传 1–${MAX_FILE_COUNT} 个资料文件`);

    files.forEach(validateFile);
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > MAX_TOTAL_SIZE) throw new Error('全部文件总大小不能超过 40 MB');

    const taskId = `task_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const initialPassport = createInitialProductPassport({ taskId, platforms, markets, now });
    const storedFiles: Array<TaskFile & { objectKey: string }> = [];

    for (const file of files) {
      const fileId = `file_${crypto.randomUUID()}`;
      const objectKey = `tasks/${taskId}/source/${fileId}-${safeFileName(file.name)}`;
      await UPLOADS.put(objectKey, file.stream(), {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
        customMetadata: { taskId, fileId, originalName: file.name },
      });
      storedObjectKeys.push(objectKey);
      storedFiles.push({
        id: fileId,
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        status: 'STORED',
        objectKey,
      });
    }

    const writes = [
      DB.prepare(
        `INSERT INTO tasks (id, product_name, status, markets_json, platforms_json, created_at, updated_at)
         VALUES (?, ?, 'CREATED', ?, ?, ?, ?)`,
      ).bind(taskId, PENDING_PRODUCT_NAME, JSON.stringify(markets), JSON.stringify(platforms), now, now),
      DB.prepare(
        `INSERT INTO task_events (task_id, from_status, to_status, actor, note, created_at)
         VALUES (?, NULL, 'CREATED', 'user', '原始资料已安全接收', ?)`,
      ).bind(taskId, now),
      ...storedFiles.map((file) => DB.prepare(
        `INSERT INTO task_files (id, task_id, filename, object_key, content_type, size, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'STORED', ?)`,
      ).bind(file.id, taskId, file.name, file.objectKey, file.contentType, file.size, now)),
      ...prepareInitialPassportWrites(DB, initialPassport),
    ];

    await DB.batch(writes);

    const task: TaskSnapshot = {
      id: taskId,
      productName: PENDING_PRODUCT_NAME,
      status: 'CREATED',
      markets,
      platforms,
      files: storedFiles.map((file) => ({
        id: file.id,
        name: file.name,
        contentType: file.contentType,
        size: file.size,
        status: file.status,
      })),
      createdAt: now,
      updatedAt: now,
    };

    return Response.json({
      task,
      targeting: {
        platforms,
        markets,
        platformSource: platformField === null ? inferredTargets.platformSource : 'explicit',
        marketSource: marketField === null ? inferredTargets.marketSource : 'explicit',
      },
    }, { status: 201 });
  } catch (error) {
    if (storedObjectKeys.length > 0) {
      const { UPLOADS } = getBindings();
      await Promise.allSettled(storedObjectKeys.map((key) => UPLOADS.delete(key)));
    }

    const message = error instanceof Error ? error.message : 'Unable to create task';
    const clientError = /required|请选择|不能|不支持|包含未知|需为|文件/.test(message);
    return Response.json({ error: message }, { status: clientError ? 400 : 500 });
  }
}
