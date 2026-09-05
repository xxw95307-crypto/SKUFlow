import type { AgentModelMessage } from '../domain/agent-orchestrator.ts';
import type {
  AgentConversationRecord,
  ConversationMessage,
  ConversationSummary,
  ConversationToolRun,
} from '../domain/conversation.ts';

interface ConversationRow {
  id: string;
  task_id: string | null;
  title: string;
  status: 'ACTIVE' | 'COMPLETED';
  messages_json: string;
  model_history_json: string;
  tool_runs_json: string;
  selected_assets_json: string;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function summary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function record(row: ConversationRow): AgentConversationRecord {
  return {
    ...summary(row),
    messages: parseJson<ConversationMessage[]>(row.messages_json, []),
    modelHistory: parseJson<AgentModelMessage[]>(row.model_history_json, []),
    toolRuns: parseJson<ConversationToolRun[]>(row.tool_runs_json, []),
    selectedAssetIds: parseJson<string[]>(row.selected_assets_json, []),
  };
}

const SELECT_COLUMNS = `id, task_id, title, status, messages_json, model_history_json,
  tool_runs_json, selected_assets_json, created_at, updated_at`;

export async function listConversations(DB: D1Database): Promise<ConversationSummary[]> {
  const result = await DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM agent_conversations ORDER BY created_at DESC, id DESC LIMIT 50`,
  ).all<ConversationRow>();
  return result.results.map(summary);
}

export async function getConversation(DB: D1Database, id: string): Promise<AgentConversationRecord | null> {
  const row = await DB.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_conversations WHERE id = ?`)
    .bind(id).first<ConversationRow>();
  return row ? record(row) : null;
}

export async function deleteConversation(DB: D1Database, id: string): Promise<void> {
  await DB.prepare('DELETE FROM agent_conversations WHERE id = ?').bind(id).run();
}

export async function createConversation(DB: D1Database, input: {
  id: string;
  taskId: string | null;
  title: string;
  messages: ConversationMessage[];
  now: string;
}): Promise<AgentConversationRecord> {
  await DB.prepare(
    `INSERT INTO agent_conversations
     (id, task_id, title, status, messages_json, model_history_json, tool_runs_json, selected_assets_json, created_at, updated_at)
     VALUES (?, ?, ?, 'ACTIVE', ?, '[]', '[]', '[]', ?, ?)`,
  ).bind(input.id, input.taskId, input.title, JSON.stringify(input.messages), input.now, input.now).run();
  return await getConversation(DB, input.id) as AgentConversationRecord;
}

export async function updateConversation(DB: D1Database, id: string, input: {
  taskId: string | null;
  title: string;
  status: 'ACTIVE' | 'COMPLETED';
  messages: ConversationMessage[];
  modelHistory: AgentModelMessage[];
  toolRuns: ConversationToolRun[];
  selectedAssetIds: string[];
  now: string;
}): Promise<AgentConversationRecord | null> {
  await DB.prepare(
    `UPDATE agent_conversations SET task_id = ?, title = ?, status = ?, messages_json = ?,
     model_history_json = ?, tool_runs_json = ?, selected_assets_json = ?, updated_at = ? WHERE id = ?`,
  ).bind(
    input.taskId, input.title, input.status, JSON.stringify(input.messages),
    JSON.stringify(input.modelHistory), JSON.stringify(input.toolRuns), JSON.stringify(input.selectedAssetIds),
    input.now, id,
  ).run();
  return getConversation(DB, id);
}
