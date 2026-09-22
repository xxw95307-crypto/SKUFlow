export const AGENT_TOOL_NAMES = [
  'inspect_chat_attachments',
  'create_listing_task_from_attachments',
  'start_listing_workflow',
  'parse_product_sources',
  'analyze_product_images',
  'merge_product_facts',
  'update_task_targets',
  'reparse_sources',
  'reanalyze_images',
  'reopen_resolved_conflicts',
  'generate_platform_listings',
  'open_conflict_review',
  'open_listing_review',
  'generate_visual_assets',
  'revise_product_video',
  'trim_product_video',
  'open_asset_selection',
  'open_publish_confirmation',
  'publish_mock_drafts',
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface AgentToolCall {
  id: string;
  type: 'function';
  function: {
    name: AgentToolName;
    arguments: string;
  };
}

export type AgentModelMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: AgentToolCall[] }
  | { role: 'tool'; toolCallId: string; name: AgentToolName; content: string };

export interface AgentWorkflowState {
  taskId: string | null;
  intakePresented: boolean;
  pendingAttachmentCount: number;
  taskStatus: string | null;
  productName: string | null;
  fileCount: number;
  parsedFileCount: number;
  imageCount: number;
  analyzedImageCount: number;
  factCount: number;
  openConflictCount: number;
  resolvedConflictCount: number;
  draftCount: number;
  generatedDraftCount: number;
  approvedDraftCount: number;
  publishedDraftCount: number;
  generatedAssetCount: number;
  selectedAssetCount: number;
  publishApproved: boolean;
  videoCandidates?: Array<{id:string;title:string;duration:number;ordinal:number}>;
}

export interface AgentToolDefinition {
  type: 'function';
  function: {
    name: AgentToolName;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      additionalProperties: false;
    };
  };
}

export interface AgentOrchestratorResponse {
  message: {
    role: 'assistant';
    content: string | null;
    toolCalls: AgentToolCall[];
  };
  model: string;
  usage: Record<string, number> | null;
  requestId: string | null;
  state: AgentWorkflowState;
}

export function isAgentToolName(value: unknown): value is AgentToolName {
  return typeof value === 'string' && AGENT_TOOL_NAMES.includes(value as AgentToolName);
}
