import { ensureSchema, getBindings } from '@/db/client';
import type { ConversationMessage } from '@/lib/domain/conversation';
import { PENDING_PRODUCT_NAME } from '@/lib/domain/task';
import { createConversation, getConversation, listConversations } from '@/lib/server/conversation-store';
import { getTaskSnapshot } from '@/lib/server/task-store';

export const dynamic = 'force-dynamic';

const welcomeMessages: ConversationMessage[] = [{
  id: 'welcome',
  role: 'agent',
  text: '你好，我是 SKUFlow Agent。你可以直接告诉我今天想做什么，例如“我要上新一款商品”，也可以先问我有关平台 Listing 的问题。',
  meta: '等待你的消息',
}];

export async function GET() {
  try {
    await ensureSchema();
    return Response.json({ conversations: await listConversations(getBindings().DB) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to list conversations' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const body = await request.json().catch(() => ({})) as { taskId?: unknown };
    const taskId = typeof body.taskId === 'string' && /^task_[a-zA-Z0-9-]+$/.test(body.taskId) ? body.taskId : null;
    const { DB } = getBindings();
    let title = '新对话';
    if (taskId) {
      const existing = await DB.prepare('SELECT id FROM agent_conversations WHERE task_id = ?').bind(taskId).first<{ id: string }>();
      if (existing) return Response.json({ conversation: await getConversation(DB, existing.id) });
      const task = await getTaskSnapshot(DB, taskId);
      if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
      if (task.productName !== PENDING_PRODUCT_NAME) title = task.productName;
    }
    const now = new Date().toISOString();
    const conversation = await createConversation(DB, {
      id: `conversation_${crypto.randomUUID()}`,
      taskId,
      title,
      messages: welcomeMessages,
      now,
    });
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to create conversation' }, { status: 500 });
  }
}
