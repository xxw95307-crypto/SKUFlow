import { ensureSchema, getBindings } from '@/db/client';
import { isAgentToolName, type AgentModelMessage } from '@/lib/domain/agent-orchestrator';
import type { ConversationMessage, ConversationToolRun } from '@/lib/domain/conversation';
import { PENDING_PRODUCT_NAME } from '@/lib/domain/task';
import { getConversation, updateConversation } from '@/lib/server/conversation-store';
import { getTaskSnapshot } from '@/lib/server/task-store';

export const dynamic = 'force-dynamic';

function parseMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('会话消息格式无效');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('会话消息格式无效');
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !['agent', 'user'].includes(String(row.role)) || typeof row.text !== 'string') {
      throw new Error('会话消息格式无效');
    }
    return {
      id: row.id.slice(0, 200),
      role: row.role as 'agent' | 'user',
      text: row.text.slice(0, 8_000),
      ...(typeof row.meta === 'string' ? { meta: row.meta.slice(0, 200) } : {}),
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

export async function GET(_request: Request, context: { params: Promise<{ conversationId: string }> }) {
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

export async function PATCH(request: Request, context: { params: Promise<{ conversationId: string }> }) {
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
