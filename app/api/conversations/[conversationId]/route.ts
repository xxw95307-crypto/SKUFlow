import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { isAgentToolName, type AgentModelMessage } from '@/lib/domain/agent-orchestrator';
import {
  CONVERSATION_MESSAGE_KINDS,
  type ConversationAttachment,
  type ConversationAssetSnapshot,
  type ConversationMessage,
  type ConversationRichItem,
  type ConversationToolRun,
} from '@/lib/domain/conversation';
import { PENDING_PRODUCT_NAME } from '@/lib/domain/task';
import { GENERATED_ASSET_KINDS } from '@/lib/domain/generated-asset';
import { deleteConversation, getConversation, updateConversation } from '@/lib/server/conversation-store';
import { getTaskSnapshot } from '@/lib/server/task-store';

export const dynamic = 'force-dynamic';

function parseMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('会话消息格式无效');
  if (JSON.stringify(value).length > 500_000) throw new Error('会话消息过大');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('会话消息格式无效');
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !['agent', 'user'].includes(String(row.role)) || typeof row.text !== 'string') {
      throw new Error('会话消息格式无效');
    }
    const kind = CONVERSATION_MESSAGE_KINDS.includes(row.kind as (typeof CONVERSATION_MESSAGE_KINDS)[number])
      ? row.kind as ConversationMessage['kind']
      : undefined;
    const attachments = Array.isArray(row.attachments) ? row.attachments.slice(0, 12).map((raw): ConversationAttachment => {
      if (!raw || typeof raw !== 'object') throw new Error('附件消息格式无效');
      const file = raw as Record<string, unknown>;
      if (typeof file.taskId !== 'string' || typeof file.fileId !== 'string' || typeof file.name !== 'string'
        || typeof file.contentType !== 'string' || typeof file.size !== 'number' || !Number.isFinite(file.size)) {
        throw new Error('附件消息格式无效');
      }
      return {
        taskId: file.taskId.slice(0, 100), fileId: file.fileId.slice(0, 100), name: file.name.slice(0, 200),
        contentType: file.contentType.slice(0, 100), size: Math.max(0, Math.round(file.size)),
      };
    }) : undefined;
    const items = Array.isArray(row.items) ? row.items.slice(0, 24).map((raw): ConversationRichItem => {
      if (!raw || typeof raw !== 'object') throw new Error('卡片消息格式无效');
      const rich = raw as Record<string, unknown>;
      if (typeof rich.id !== 'string' || typeof rich.label !== 'string' || typeof rich.value !== 'string') {
        throw new Error('卡片消息格式无效');
      }
      return {
        id: rich.id.slice(0, 120), label: rich.label.slice(0, 200), value: rich.value.slice(0, 4_000),
        ...(typeof rich.detail === 'string' ? { detail: rich.detail.slice(0, 500) } : {}),
        ...(typeof rich.status === 'string' ? { status: rich.status.slice(0, 100) } : {}),
      };
    }) : undefined;
    const assets = Array.isArray(row.assets) ? row.assets.slice(0, 20).map((raw): ConversationAssetSnapshot => {
      if (!raw || typeof raw !== 'object') throw new Error('图片结果格式无效');
      const asset = raw as Record<string, unknown>;
      if (typeof asset.id !== 'string' || !/^asset_[\w-]+$/.test(asset.id)
        || typeof asset.taskId !== 'string' || !/^task_[\w-]+$/.test(asset.taskId)
        || (asset.kind !== 'VIDEO' && !GENERATED_ASSET_KINDS.includes(asset.kind as (typeof GENERATED_ASSET_KINDS)[number]))
        || typeof asset.title !== 'string') throw new Error('图片结果格式无效');
      const dimension = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10000 ? Math.round(value) : null;
      return {
        id: asset.id.slice(0, 100), taskId: asset.taskId.slice(0, 100), kind: asset.kind as ConversationAssetSnapshot['kind'],
        title: asset.title.slice(0, 120), width: dimension(asset.width), height: dimension(asset.height),
        error: typeof asset.error === 'string' ? asset.error.slice(0, 500) : null,
      };
    }) : undefined;
    let tool: ConversationMessage['tool'];
    if (row.tool && typeof row.tool === 'object') {
      const rawTool = row.tool as Record<string, unknown>;
      if (!isAgentToolName(rawTool.name) || !['RUNNING', 'COMPLETED', 'FAILED'].includes(String(rawTool.status))) {
        throw new Error('工具消息格式无效');
      }
      tool = { name: rawTool.name, status: rawTool.status as NonNullable<ConversationMessage['tool']>['status'] };
    }
    return {
      id: row.id.slice(0, 200),
      role: row.role as 'agent' | 'user',
      text: row.text.slice(0, 8_000),
      ...(typeof row.meta === 'string' ? { meta: row.meta.slice(0, 200) } : {}),
      ...(kind ? { kind } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(items?.length ? { items } : {}),
      ...(assets?.length ? { assets } : {}),
      ...(tool ? { tool } : {}),
    };
  });
}

function parseModelHistory(value: unknown): AgentModelMessage[] {
  if (!Array.isArray(value) || value.length > 48) throw new Error('模型记忆格式无效');
  const serialized = JSON.stringify(value);
  if (serialized.length > 160_000) throw new Error('模型记忆过大');
  return value as AgentModelMessage[];
}

function parseToolRuns(value: unknown): ConversationToolRun[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error('工具记录格式无效');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('工具记录格式无效');
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !isAgentToolName(row.name) || !['RUNNING', 'COMPLETED', 'FAILED'].includes(String(row.status))) {
      throw new Error('工具记录格式无效');
    }
    return { id: row.id.slice(0, 200), name: row.name, status: row.status as ConversationToolRun['status'] };
  });
}

async function handleGET(_request: Request, context: { params: Promise<{ conversationId: string }> }) {
  try {
    await ensureSchema();
    const { conversationId } = await context.params;
    const conversation = await getConversation(getBindings().DB, conversationId);
    if (!conversation) return Response.json({ error: 'Conversation not found' }, { status: 404 });
    return Response.json({ conversation });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to load conversation' }, { status: 500 });
  }
}

async function handlePATCH(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  try {
    await ensureSchema();
    const { conversationId } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const { DB } = getBindings();
    const current = await getConversation(DB, conversationId);
    if (!current) return Response.json({ error: 'Conversation not found' }, { status: 404 });
    const taskId = body.taskId === null
      ? null
      : typeof body.taskId === 'string' && /^task_[a-zA-Z0-9-]+$/.test(body.taskId) ? body.taskId : current.taskId;
    let title = current.title;
    if (taskId) {
      const task = await getTaskSnapshot(DB, taskId);
      if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
      if (task.productName !== PENDING_PRODUCT_NAME) title = task.productName;
    }
    if (typeof body.title === 'string' && body.title.trim()) title = body.title.trim().slice(0, 120);
    const selectedAssetIds = Array.isArray(body.selectedAssetIds)
      ? [...new Set(body.selectedAssetIds.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 100)))].slice(0, 20)
      : current.selectedAssetIds;
    const status = body.status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE';
    const conversation = await updateConversation(DB, conversationId, {
      taskId,
      title,
      status,
      messages: body.messages === undefined ? current.messages : parseMessages(body.messages),
      modelHistory: body.modelHistory === undefined ? current.modelHistory : parseModelHistory(body.modelHistory),
      toolRuns: body.toolRuns === undefined ? current.toolRuns : parseToolRuns(body.toolRuns),
      selectedAssetIds,
      now: new Date().toISOString(),
    });
    return Response.json({ conversation });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update conversation';
    return Response.json({ error: message }, { status: /格式|过大/.test(message) ? 400 : 500 });
  }
}

async function handleDELETE(_request: Request, context: { params: Promise<{ conversationId: string }> }) {
  try {
    await ensureSchema();
    const { conversationId } = await context.params;
    const { DB } = getBindings();
    const current = await getConversation(DB, conversationId);
    if (!current) return Response.json({ error: 'Conversation not found' }, { status: 404 });
    await deleteConversation(DB, conversationId);
    return Response.json({ deleted: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to delete conversation' }, { status: 500 });
  }
}

export const GET = withAuthentication(handleGET);
export const PATCH = withAuthentication(handlePATCH);
export const DELETE = withAuthentication(handleDELETE);
