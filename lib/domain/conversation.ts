import type { AgentModelMessage, AgentToolName } from './agent-orchestrator.ts';
import type { GeneratedAssetKind } from './generated-asset.ts';

export const CONVERSATION_MESSAGE_KINDS = ['text', 'files', 'tool', 'decision', 'listing', 'assets', 'video', 'publish'] as const;
export type ConversationMessageKind = (typeof CONVERSATION_MESSAGE_KINDS)[number];

export interface ConversationAttachment {
  taskId: string;
  fileId: string;
  name: string;
  contentType: string;
  size: number;
}

export interface ConversationRichItem {
  id: string;
  label: string;
  value: string;
  detail?: string;
  status?: string;
}

export interface ConversationAssetSnapshot {
  id: string;
  taskId: string;
  kind: GeneratedAssetKind;
  title: string;
  width: number | null;
  height: number | null;
  error: string | null;
}

export interface ConversationMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
  meta?: string;
  kind?: ConversationMessageKind;
  attachments?: ConversationAttachment[];
  items?: ConversationRichItem[];
  assets?: ConversationAssetSnapshot[];
  videoJobIds?: string[];
  tool?: {
    name: AgentToolName;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  };
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
