import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { availableAgentTools, withBacktrackTools, withRegenerationTool, buildCommerceOrchestratorPrompt, restrictIntakeToolsForListingRequest, soleRequiredAgentTool } from '@/lib/agents/commerce-orchestrator';
import { callBailianOrchestrator } from '@/lib/ai/bailian-client';
import { loadBailianConfig, missingBailianConfig } from '@/lib/config/bailian';
import {
  isAgentToolName,
  type AgentModelMessage,
  type AgentWorkflowState,
} from '@/lib/domain/agent-orchestrator';
import { PENDING_PRODUCT_NAME } from '@/lib/domain/task';
import { getProductPassport } from '@/lib/server/passport-store';
import { getTaskSnapshot } from '@/lib/server/task-store';
import { getLatestCompletedVisionRuns } from '@/lib/server/vision-analysis-store';
import { listLatestGeneratedAssets } from '@/lib/server/generated-asset-store';
import { inferConversationTargets } from '@/lib/agents/intake-targets';

export const dynamic = 'force-dynamic';

interface RequestBody {
  taskId?: unknown;
  messages?: unknown;
  selectedAssetIds?: unknown;
  imagesConfirmed?: unknown;
  imageBriefConfirmed?: unknown;
  videoStageComplete?: unknown;
  publishApproved?: unknown;
  requireAction?: unknown;
  intakePresented?: unknown;
  pendingAttachmentCount?: unknown;
}

function parseMessages(value: unknown): AgentModelMessage[] {
  if (!Array.isArray(value)) throw new Error('messages must be an array');
  if (value.length === 0 || value.length > 48) throw new Error('对话消息数量需为 1-48 条');
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
  const selectedAssetIds = new Set(Array.isArray(body.selectedAssetIds)
    ? body.selectedAssetIds.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : []);
  const pendingAttachmentCount = typeof body.pendingAttachmentCount === 'number' && Number.isInteger(body.pendingAttachmentCount)
    ? Math.min(12, Math.max(0, body.pendingAttachmentCount))
    : 0;
  const empty: AgentWorkflowState = {
    taskId: null, intakePresented: body.intakePresented === true, pendingAttachmentCount, taskStatus: null, productName: null, fileCount: 0, parsedFileCount: 0,
    imageCount: 0, analyzedImageCount: 0, factCount: 0, openConflictCount: 0, resolvedConflictCount: 0,
    draftCount: 0, generatedDraftCount: 0, approvedDraftCount: 0, publishedDraftCount: 0,
    generatedAssetCount: 0,
    imageBriefConfirmed: body.imageBriefConfirmed === true,
    selectedAssetCount: 0, selectedImageCount: 0, imagesConfirmed: body.imagesConfirmed === true, videoJobCount: 0,
    videoStageComplete: body.videoStageComplete === true, publishApproved: body.publishApproved === true,
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
  const [visionRuns, generatedAssets] = await Promise.all([
    getLatestCompletedVisionRuns(DB, taskId),
    listLatestGeneratedAssets(DB, taskId),
  ]);
  const completedAssets = generatedAssets.filter((asset) => asset.status === 'COMPLETED' && asset.batchId.startsWith('asset_dynamic_'));
  const videos=await DB.prepare("SELECT id,plan_json FROM video_jobs WHERE task_id=? AND status='SUCCEEDED' ORDER BY created_at DESC, id DESC").bind(taskId).all<{id:string;plan_json:string}>();
  const relevantVideoJobs = await DB.prepare("SELECT source_file_id FROM video_jobs WHERE task_id=? AND status NOT IN ('CANCELED','TRIM_DRAFT')").bind(taskId).all<{source_file_id:string}>();
  const generatedDrafts = passport.platformDrafts.filter((draft) => draft.status !== 'PLANNED' && Object.keys(draft.payload).length > 0);
  const approvedDrafts = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
  return {
    taskId, intakePresented: true, pendingAttachmentCount,
    taskStatus: task.status,
    productName: task.productName === PENDING_PRODUCT_NAME ? null : task.productName,
    fileCount: task.files.length,
    parsedFileCount: Number(parsed?.count ?? 0),
    imageCount: task.files.filter((file) => file.contentType.startsWith('image/')).length,
    analyzedImageCount: new Set(visionRuns.map((run) => run.fileId)).size,
    factCount: passport.facts.filter((fact) => fact.status !== 'MISSING').length,
    openConflictCount: passport.conflicts.filter((conflict) => conflict.status === 'OPEN').length,
    resolvedConflictCount: passport.conflicts.filter((conflict) => conflict.status !== 'OPEN').length,
    draftCount: passport.platformDrafts.length,
    generatedDraftCount: generatedDrafts.length,
    approvedDraftCount: approvedDrafts.length,
    publishedDraftCount: passport.platformDrafts.filter((draft) => draft.status === 'DRAFT_CREATED').length,
    videoCandidates: videos.results.map((v,index)=>{const p=JSON.parse(v.plan_json);return {id:v.id,title:p.title,duration:p.duration,ordinal:index+1};}),
    generatedAssetCount: completedAssets.length + videos.results.length,
    imageBriefConfirmed: body.imageBriefConfirmed === true,
    selectedAssetCount: completedAssets.filter((asset) => selectedAssetIds.has(asset.id)).length + videos.results.filter(v=>selectedAssetIds.has(v.id)).length,
    selectedImageCount: completedAssets.filter((asset) => selectedAssetIds.has(asset.id)).length,
    imagesConfirmed: body.imagesConfirmed === true,
    videoJobCount: relevantVideoJobs.results.filter((job) => selectedAssetIds.has(job.source_file_id)).length,
    videoStageComplete: body.videoStageComplete === true,
    publishApproved: body.publishApproved === true,
  };
}


function requestsListingStart(messages: AgentModelMessage[], state: AgentWorkflowState): boolean {
  if (state.taskId) return false;
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  if (lastUser?.role !== 'user') return false;
  return /(?:我要|我想|帮我|开始|准备|需要).{0,16}(?:上新|发布商品|创建.{0,8}listing|制作.{0,8}listing)/i.test(lastUser.content)
    || /(?:上新|发布).{0,10}(?:一款|一个|商品|产品)/i.test(lastUser.content);
}

async function handlePOST(request: Request) {
  try {
    await ensureSchema();
    const body = await request.json() as RequestBody;
    const messages = parseMessages(body.messages);
    const state = await loadWorkflowState(body);
    const bindings = getBindings();
    const config = loadBailianConfig(bindings);
    const missing = missingBailianConfig(config);
    if (missing.length > 0) return Response.json({ error: `百炼运行时配置不完整：${missing.join(', ')}` }, { status: 503 });
    const listingStartRequested = requestsListingStart(messages, state);
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const stateTools = availableAgentTools(state);
    const knownTargets = inferConversationTargets(messages);
    const targetAwareTools = listingStartRequested && lastUser?.role === 'user'
      ? restrictIntakeToolsForListingRequest(stateTools, state, [...knownTargets.platforms, ...knownTargets.markets].join(' '))
      : stateTools;
    const candidateTools = withBacktrackTools(withRegenerationTool(targetAwareTools, messages, state), messages, state);
    const requiredNext = lastUser?.role === 'user' && lastUser.content.startsWith('我已确认图片生成需求，请生成图片')
      ? 'generate_visual_assets'
      : lastUser?.role === 'user' && lastUser.content.includes('我已确认最终图片，请根据这些图片生成视频')
      ? 'generate_product_video'
      : lastUser?.role === 'user' && (lastUser.content.includes('图片与视频阶段已完成，请进入最终交付确认') || lastUser.content.includes('我已确认图片，本次不需要视频，请进入最终交付确认'))
        ? 'open_publish_confirmation'
        : null;
    const tools = requiredNext && candidateTools.some((item) => item.function.name === requiredNext)
      ? candidateTools.filter((item) => item.function.name === requiredNext)
      : candidateTools;
    const requireTool = (body.requireAction === true || listingStartRequested) && tools.length > 0;
    const soleTool = soleRequiredAgentTool(tools, requireTool);
    let result;
    try {
      result = await callBailianOrchestrator(config, {
        systemPrompt: buildCommerceOrchestratorPrompt(state) + `\n本会话用户已明确提及的目标：${JSON.stringify(knownTargets)}。结合完整上下文判断这些是否为当前上新选择；不是选择或含否定、疑问时先用自然语言澄清。资料和目标齐全时直接创建任务；缺少目标时仅询问缺失项，不要求重新上传现有附件。用户在补答平台或市场时，沿用之前的上新意图和附件。`,
        messages,
        tools,
        requireTool,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!soleTool || message !== '百炼 Agent 未返回回复或工具调用') throw error;
      result = {
        message: {
          role: 'assistant' as const,
          content: '我会继续执行当前唯一可用的安全步骤。',
          toolCalls: [{
            id: `call_fallback_${crypto.randomUUID()}`,
            type: 'function' as const,
            function: { name: soleTool.function.name, arguments: '{}' },
          }],
        },
        model: config.model,
        usage: null,
        requestId: null,
      };
    }
    const allowed = new Set(tools.map((item) => item.function.name));
    let toolCalls = result.message.toolCalls.filter((call) => allowed.has(call.function.name)).slice(0, 1);
    if (toolCalls.length === 0 && soleTool) {
      toolCalls = [{
        id: `call_fallback_${crypto.randomUUID()}`,
        type: 'function',
        function: { name: soleTool.function.name, arguments: '{}' },
      }];
    }
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

export const POST = withAuthentication(handlePOST);
