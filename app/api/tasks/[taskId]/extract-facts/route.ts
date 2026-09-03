import { ensureSchema, getBindings } from '@/db/client';
import { buildFactExtractionContext, FACT_EXTRACTION_PROMPT_VERSION } from '@/lib/agents/fact-extraction';
import { callBailianFactExtraction, hashExtractionInput } from '@/lib/ai/bailian-client';
import { loadBailianConfig, missingBailianConfig } from '@/lib/config/bailian';
import { loadBailianVisionConfig, missingBailianVisionConfig } from '@/lib/config/bailian-vision';
import type { AgentRun } from '@/lib/domain/fact-extraction';
import type { TaskStatus } from '@/lib/domain/task';
import {
  applyFactExtraction,
  getLatestAgentRun,
  prepareAgentRunFailure,
  prepareAgentRunStart,
} from '@/lib/server/fact-extraction-store';
import { getParseResults } from '@/lib/server/parse-store';
import { getProductPassport } from '@/lib/server/passport-store';
import { getTaskSnapshot, prepareTaskTransition } from '@/lib/server/task-store';
import { getLatestCompletedVisionRuns } from '@/lib/server/vision-analysis-store';
import { assertTransition } from '@/lib/workflow/task-machine';

export const dynamic = 'force-dynamic';

interface TaskRow {
  id: string;
  status: TaskStatus;
}

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const bindings = getBindings();
    const config = loadBailianConfig(bindings);
    const visionConfig = loadBailianVisionConfig(bindings);
    const task = await getTaskSnapshot(bindings.DB, taskId);
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    return Response.json({
      task,
      run: await getLatestAgentRun(bindings.DB, taskId),
      provider: {
        name: '阿里云百炼',
        model: config.model || '未配置',
        configured: missingBailianConfig(config).length === 0,
        visionSupported: missingBailianVisionConfig(visionConfig).length === 0,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to load extraction state' },
      { status: 500 },
    );
  }
}

export async function POST(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  let DB: D1Database | null = null;
  let runId: string | null = null;
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const bindings = getBindings();
    DB = bindings.DB;
    const config = loadBailianConfig(bindings);
    const missingConfig = missingBailianConfig(config);
    if (missingConfig.length > 0) {
      return Response.json({ error: `百炼运行时配置不完整：${missingConfig.join(', ')}` }, { status: 503 });
    }

    const task = await DB.prepare('SELECT id, status FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<TaskRow>();
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    if (!['FILES_PARSED', 'FACTS_EXTRACTED', 'NEEDS_CONFIRMATION'].includes(task.status)) {
      return Response.json({ error: `当前任务状态 ${task.status} 尚不能执行事实抽取` }, { status: 409 });
    }

    const passport = await getProductPassport(DB, taskId);
    if (!passport) return Response.json({ error: 'Product passport not found' }, { status: 404 });
    if (passport.status === 'LOCKED') return Response.json({ error: 'Product passport is locked' }, { status: 409 });
    const parseResults = await getParseResults(DB, taskId);
    const visionRuns = await getLatestCompletedVisionRuns(DB, taskId);
    const contextData = buildFactExtractionContext(
      parseResults.filter((result) => result.status !== 'FAILED'),
      visionRuns,
    );
    if (contextData.items.length === 0) {
      return Response.json({
        error: contextData.imageBlocksPending > 0
          ? '任务只有尚未理解的图片内容，请先配置并运行视觉 Agent'
          : '没有可供事实 Agent 使用的解析文本',
      }, { status: 409 });
    }

    const now = new Date().toISOString();
    runId = `run_${crypto.randomUUID()}`;
    const run: AgentRun = {
      id: runId,
      taskId,
      passportId: passport.id,
      provider: 'BAILIAN',
      model: config.model,
      promptVersion: FACT_EXTRACTION_PROMPT_VERSION,
      status: 'RUNNING',
      inputHash: await hashExtractionInput(contextData.prompt),
      result: null,
      usage: null,
      error: null,
      createdAt: now,
      completedAt: null,
    };
    await prepareAgentRunStart(DB, run).run();

    const modelResponse = await callBailianFactExtraction(config, contextData);
    const completedAt = new Date().toISOString();
    const summary = await applyFactExtraction(DB, {
      runId,
      passport,
      evidenceItems: contextData.items,
      output: modelResponse.output,
      usage: modelResponse.usage,
      model: modelResponse.model,
      imageBlocksPending: contextData.imageBlocksPending,
      now: completedAt,
    });

    let currentStatus = task.status;
    if (currentStatus === 'FILES_PARSED') {
      assertTransition(currentStatus, 'FACTS_EXTRACTED');
      await DB.batch(prepareTaskTransition(DB, {
        taskId,
        fromStatus: currentStatus,
        toStatus: 'FACTS_EXTRACTED',
        actor: 'agent',
        note: `百炼 ${modelResponse.model} 已完成事实抽取`,
        now: completedAt,
      }));
      currentStatus = 'FACTS_EXTRACTED';
    }
    if ((summary.conflicts > 0 || summary.missing > 0) && currentStatus === 'FACTS_EXTRACTED') {
      assertTransition(currentStatus, 'NEEDS_CONFIRMATION');
      await DB.batch(prepareTaskTransition(DB, {
        taskId,
        fromStatus: currentStatus,
        toStatus: 'NEEDS_CONFIRMATION',
        actor: 'agent',
        note: `需要确认：${summary.conflicts} 项冲突，${summary.missing} 项缺失`,
        now: completedAt,
      }));
    }

    return Response.json({
      task: await getTaskSnapshot(DB, taskId),
      passport: await getProductPassport(DB, taskId),
      run: await getLatestAgentRun(DB, taskId),
      summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '事实抽取失败';
    if (DB && runId) {
      await prepareAgentRunFailure(DB, runId, message, new Date().toISOString()).run().catch(() => undefined);
    }
    const conflict = message.startsWith('Invalid task transition');
    const providerError = /百炼|模型/.test(message);
    return Response.json({ error: message }, { status: conflict ? 409 : providerError ? 502 : 500 });
  }
}
