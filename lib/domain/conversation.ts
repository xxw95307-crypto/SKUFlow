import type { AgentModelMessage, AgentToolName } from './agent-orchestrator.ts';

export interface ConversationMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
  meta?: string;
}

export interface ConversationToolRun {
  id: string;
  name: AgentToolName;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
}

export interface ConversationSummary {
  id: string;
  taskId: string | null;
  title: string;
  status: 'ACTIVE' | 'COMPLETED';
  createdAt: string;
  updatedAt: string;
}

export interface AgentConversationRecord extends ConversationSummary {
  messages: ConversationMessage[];
  modelHistory: AgentModelMessage[];
  toolRuns: ConversationToolRun[];
  selectedAssetIds: string[];
}
