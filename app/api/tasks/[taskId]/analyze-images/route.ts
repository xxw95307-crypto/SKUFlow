import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { VISION_ANALYSIS_PROMPT_VERSION } from '@/lib/agents/vision-analysis';
import { callBailianVisionAnalysis, hashVisionInput } from '@/lib/ai/bailian-client';
import { loadBailianConfig, missingBailianConfig } from '@/lib/config/bailian';
import { PENDING_PRODUCT_NAME, type TaskStatus } from '@/lib/domain/task';
import type { VisionAgentRun } from '@/lib/domain/vision-analysis';
import { getProductPassport, resetPlannedDrafts } from '@/lib/server/passport-store';
import { getTaskSnapshot } from '@/lib/server/task-store';
import {
  getLatestVisionRunForFile,
  getLatestVisionRuns,
  prepareVisionRunComplete,
  prepareVisionRunFailure,
  prepareVisionRunStart,
  summarizeVisionRuns,
} from '@/lib/server/vision-analysis-store';

export const dynamic = 'force-dynamic';

interface ImageFileRow {
  id: string;
  filename: string;
  object_key: string;
  content_type: string;
  size: number;
}

async function getImageFiles(DB: D1Database, taskId: string): Promise<ImageFileRow[]> {
  const result = await DB.prepare(
    `SELECT id, filename, object_key, content_type, size
     FROM task_files WHERE task_id = ? AND content_type LIKE 'image/%' ORDER BY created_at ASC`,
  ).bind(taskId).all<ImageFileRow>();
  return result.results;
}

async function parseForce(request: Request): Promise<boolean> {
  const raw = await request.text();
  if (!raw.trim()) return false;
  try {
    const body = JSON.parse(raw) as { force?: unknown };
    return body.force === true;
  } catch {
    throw new Error('请求 JSON 格式无效');
  }
}

async function handleGET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const bindings = getBindings();
    const task = await getTaskSnapshot(bindings.DB, taskId);
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    const config = loadBailianConfig(bindings);
    const files = await getImageFiles(bindings.DB, taskId);
    const runs = await getLatestVisionRuns(bindings.DB, taskId);
    return Response.json({
      provider: {
        name: '阿里云百炼',
        model: config.model || '未配置',
        configured: missingBailianConfig(config).length === 0,
        missing: missingBailianConfig(config),
      },
      files: files.map((file) => ({ id: file.id, filename: file.filename, contentType: file.content_type, size: file.size })),
      runs,
      summary: summarizeVisionRuns(runs, files.length),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to load Vision Agent state' },
      { status: 500 },
    );
  }
}

async function handlePOST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const force = await parseForce(request);
    const bindings = getBindings();
    const config = loadBailianConfig(bindings);
    const missingConfig = missingBailianConfig(config);
    if (missingConfig.length > 0) {
      return Response.json({ error: `百炼运行时配置不完整：${missingConfig.join(', ')}` }, { status: 503 });
    }

    const task = await bindings.DB.prepare('SELECT id, product_name, status FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<{ id: string; product_name: string; status: TaskStatus }>();
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    if (!['FILES_PARSED', 'FACTS_EXTRACTED', 'NEEDS_CONFIRMATION', 'CATEGORY_MAPPED', 'CONTENT_GENERATED', 'VALIDATED'].includes(task.status)) {
      return Response.json({ error: `当前任务状态 ${task.status} 尚不能执行视觉分析，请先完成源文件解析` }, { status: 409 });
    }

    const passport = await getProductPassport(bindings.DB, taskId);
    if (!passport) return Response.json({ error: 'Product passport not found' }, { status: 404 });
    if (passport.status === 'LOCKED') return Response.json({ error: 'Product passport is locked' }, { status: 409 });
    const files = await getImageFiles(bindings.DB, taskId);
    if (files.length === 0) return Response.json({ error: '当前任务没有图片文件' }, { status: 409 });
    if (force) {
      // 强制重分析意味着可见属性证据会更新：作废未发布的旧审校稿，由编排器引导重新生成。
      await resetPlannedDrafts(bindings.DB, taskId);
    }

    for (const file of files.slice(0, 12)) {
      const existing = await getLatestVisionRunForFile(bindings.DB, file.id);
      if (!force
        && existing?.status === 'COMPLETED'
        && existing.model === config.model
        && existing.promptVersion === VISION_ANALYSIS_PROMPT_VERSION) continue;
      const runId = `vision_${crypto.randomUUID()}`;
      let runStarted = false;
      try {
        const source = await bindings.UPLOADS.get(file.object_key);
        if (!source) throw new Error('对象存储中未找到原始图片');
        const bytes = new Uint8Array(await source.arrayBuffer());
        const now = new Date().toISOString();
        const run: VisionAgentRun = {
          id: runId,
          taskId,
          passportId: passport.id,
          fileId: file.id,
          provider: 'BAILIAN',
          model: config.model,
          promptVersion: VISION_ANALYSIS_PROMPT_VERSION,
          status: 'RUNNING',
          inputHash: await hashVisionInput(bytes),
          result: null,
          usage: null,
          error: null,
          createdAt: now,
          completedAt: null,
        };
        await prepareVisionRunStart(bindings.DB, run).run();
        runStarted = true;
        const modelResponse = await callBailianVisionAnalysis(config, {
          bytes,
          contentType: file.content_type,
          filename: file.filename,
          productName: task.product_name === PENDING_PRODUCT_NAME ? null : task.product_name,
        });
        await prepareVisionRunComplete(bindings.DB, {
          runId,
          model: modelResponse.model,
          output: modelResponse.output,
          usage: modelResponse.usage,
          completedAt: new Date().toISOString(),
        }).run();
      } catch (error) {
        const message = error instanceof Error ? error.message : '视觉分析失败';
        if (runStarted) {
          await prepareVisionRunFailure(bindings.DB, runId, message, new Date().toISOString()).run().catch(() => undefined);
        } else {
          const failedAt = new Date().toISOString();
          const failedRun: VisionAgentRun = {
            id: runId,
            taskId,
            passportId: passport.id,
            fileId: file.id,
            provider: 'BAILIAN',
            model: config.model,
            promptVersion: VISION_ANALYSIS_PROMPT_VERSION,
            status: 'RUNNING',
            inputHash: `unavailable:${file.id}`,
            result: null,
            usage: null,
            error: null,
            createdAt: failedAt,
            completedAt: null,
          };
          await bindings.DB.batch([
            prepareVisionRunStart(bindings.DB, failedRun),
            prepareVisionRunFailure(bindings.DB, runId, message, failedAt),
          ]).catch(() => undefined);
        }
      }
    }

    const runs = await getLatestVisionRuns(bindings.DB, taskId);
    return Response.json({ runs, summary: summarizeVisionRuns(runs, files.length) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '视觉分析失败';
    return Response.json(
      { error: message },
      { status: message === '请求 JSON 格式无效' ? 400 : /百炼|视觉模型/.test(message) ? 502 : 500 },
    );
  }
}

export const GET = withAuthentication(handleGET);
export const POST = withAuthentication(handlePOST);
