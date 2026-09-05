import { ensureSchema, getBindings } from '@/db/client';
import { availableAgentTools, buildCommerceOrchestratorPrompt } from '@/lib/agents/commerce-orchestrator';
import { callBailianOrchestrator } from '@/lib/ai/bailian-client';
import { loadBailianConfig, missingBailianConfig } from '@/lib/config/bailian';
import {
  isAgentToolName,
  type AgentModelMessage,
  type AgentToolDefinition,
  type AgentWorkflowState,
} from '@/lib/domain/agent-orchestrator';
import { PENDING_PRODUCT_NAME } from '@/lib/domain/task';
import { getProductPassport } from '@/lib/server/passport-store';
import { getTaskSnapshot } from '@/lib/server/task-store';
import { getLatestCompletedVisionRuns } from '@/lib/server/vision-analysis-store';

export const dynamic = 'force-dynamic';

interface RequestBody {
  taskId?: unknown;
  messages?: unknown;
  selectedAssetIds?: unknown;
  publishApproved?: unknown;
  requireAction?: unknown;
  intakePresented?: unknown;
}

function parseMessages(value: unknown): AgentModelMessage[] {
  if (!Array.isArray(value)) throw new Error('messages must be an array');
  if (value.length === 0 || value.length > 48) throw new Error('对话消息数量需为 1–48 条');
  return value.map((item): AgentModelMessage => {
    if (!item || typeof item !== 'object') throw new Error('对话消息格式无效');
    const record = item as Record<string, unknown>;
    if (record.role === 'user') {
      const content = typeof record.content === 'string' ? record.content.trim() : '';
      if (!content || content.length > 4_000) throw new Error('用户消息内容无效');
      return { role: 'user', content };
    }
    if (record.role === 'assistant') {
      const content = typeof record.content === 'string' ? record.content.slice(0, 4_000) : null;
      const rawCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
      const toolCalls = rawCalls.map((raw) => {
        if (!raw || typeof raw !== 'object') throw new Error('工具调用记录无效');
        const call = raw as Record<string, unknown>;
        const fn = call.function as Record<string, unknown> | undefined;
        if (typeof call.id !== 'string' || !isAgentToolName(fn?.name)) throw new Error('工具调用记录无效');
        return {
          id: call.id.slice(0, 200),
          type: 'function' as const,
          function: { name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments.slice(0, 4_000) : '{}' },
        };
      });
      if (!content && toolCalls.length === 0) throw new Error('Agent 消息内容无效');
      return { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}) };
    }
    if (record.role === 'tool') {
      if (typeof record.toolCallId !== 'string' || !isAgentToolName(record.name) || typeof record.content !== 'string') {
        throw new Error('工具结果记录无效');
      }
      return {
        role: 'tool',
        toolCallId: record.toolCallId.slice(0, 200),
        name: record.name,
        content: record.content.slice(0, 8_000),
      };
    }
    throw new Error('不支持的对话角色');
  });
}

async function loadWorkflowState(body: RequestBody): Promise<AgentWorkflowState> {
  const taskId = typeof body.taskId === 'string' && /^task_[a-zA-Z0-9-]+$/.test(body.taskId) ? body.taskId : null;
  const selectedAssetCount = Array.isArray(body.selectedAssetIds)
    ? new Set(body.selectedAssetIds.filter((item): item is string => typeof item === 'string').slice(0, 20)).size
    : 0;
  const empty: AgentWorkflowState = {
    taskId: null, intakePresented: body.intakePresented === true, taskStatus: null, productName: null, fileCount: 0, parsedFileCount: 0,
    imageCount: 0, analyzedImageCount: 0, factCount: 0, openConflictCount: 0,
    draftCount: 0, generatedDraftCount: 0, approvedDraftCount: 0, publishedDraftCount: 0,
    selectedAssetCount, publishApproved: body.publishApproved === true,
  };
  if (!taskId) return empty;
  const { DB } = getBindings();
  const task = await getTaskSnapshot(DB, taskId);
  if (!task) throw new Error('Task not found');
  const passport = await getProductPassport(DB, taskId);
  if (!passport) throw new Error('Product passport not found');
  const parsed = await DB.prepare(
    `SELECT COUNT(*) AS count FROM file_parse_results
     WHERE task_id = ? AND status IN ('COMPLETED', 'PARTIAL')`,
  ).bind(taskId).first<{ count: number }>();
  const visionRuns = await getLatestCompletedVisionRuns(DB, taskId);
  const generatedDrafts = passport.platformDrafts.filter((draft) => draft.status !== 'PLANNED' && Object.keys(draft.payload).length > 0);
  const approvedDrafts = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
  return {
    taskId, intakePresented: true,
    taskStatus: task.status,
    productName: task.productName === PENDING_PRODUCT_NAME ? null : task.productName,
    fileCount: task.files.length,
    parsedFileCount: Number(parsed?.count ?? 0),
    imageCount: task.files.filter((file) => file.contentType.startsWith('image/')).length,
    analyzedImageCount: new Set(visionRuns.map((run) => run.fileId)).size,
    factCount: passport.facts.filter((fact) => fact.status !== 'MISSING').length,
    openConflictCount: passport.conflicts.filter((conflict) => conflict.status === 'OPEN').length,
    draftCount: passport.platformDrafts.length,
    generatedDraftCount: generatedDrafts.length,
    approvedDraftCount: approvedDrafts.length,
    publishedDraftCount: passport.platformDrafts.filter((draft) => draft.status === 'DRAFT_CREATED').length,
    selectedAssetCount,
    publishApproved: body.publishApproved === true,
  };
}

function withRegenerationTool(tools: AgentToolDefinition[], messages: AgentModelMessage[], state: AgentWorkflowState): AgentToolDefinition[] {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const requested = lastUser?.role === 'user' && /重新生成|重写|再生成/.test(lastUser.content);
  if (!requested || state.factCount === 0 || state.openConflictCount > 0 || state.publishedDraftCount > 0) return tools;
  if (tools.some((item) => item.function.name === 'generate_platform_listings')) return tools;
  return [...tools, {
    type: 'function',
    function: {
      name: 'generate_platform_listings',
      description: '按用户最新要求重新生成各平台中文 Listing 审校稿。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  }];
}

function requestsListingStart(messages: AgentModelMessage[], state: AgentWorkflowState): boolean {
  if (state.taskId || state.intakePresented) return false;
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  if (lastUser?.role !== 'user') return false;
  return /(?:我要|我想|帮我|开始|准备|需要).{0,16}(?:上新|发布商品|创建.{0,8}listing|制作.{0,8}listing)/i.test(lastUser.content)
    || /(?:上新|发布).{0,10}(?:一款|一个|商品|产品)/i.test(lastUser.content);
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const body = await request.json() as RequestBody;
    const messages = parseMessages(body.messages);
    const state = await loadWorkflowState(body);
    const bindings = getBindings();
    const config = loadBailianConfig(bindings);
    const missing = missingBailianConfig(config);
    if (missing.length > 0) return Response.json({ error: `百炼运行时配置不完整：${missing.join(', ')}` }, { status: 503 });
    const tools = withRegenerationTool(availableAgentTools(state), messages, state);
    const result = await callBailianOrchestrator(config, {
      systemPrompt: buildCommerceOrchestratorPrompt(state),
      messages,
      tools,
      requireTool: (body.requireAction === true || requestsListingStart(messages, state)) && tools.length > 0,
    });
    const allowed = new Set(tools.map((item) => item.function.name));
    const toolCalls = result.message.toolCalls.filter((call) => allowed.has(call.function.name)).slice(0, 1);
    if (result.message.toolCalls.length > 0 && toolCalls.length === 0) {
      return Response.json({ error: 'Agent 请求了当前状态不允许使用的工具' }, { status: 409 });
    }
    return Response.json({ ...result, message: { ...result.message, toolCalls }, state });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agent 编排失败';
    const clientError = /messages must|消息|工具调用|工具结果|对话角色/.test(message);
    const notFound = message === 'Task not found' || message === 'Product passport not found';
    return Response.json({ error: message }, { status: notFound ? 404 : clientError ? 400 : /百炼|Agent/.test(message) ? 502 : 500 });
  }
}
