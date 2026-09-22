import type { TaskStatus } from '../domain/task';

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  CREATED: ['INGESTING', 'FAILED'],
  INGESTING: ['FILES_PARSED', 'FAILED'],
  FILES_PARSED: ['FACTS_EXTRACTED', 'INGESTING', 'FAILED'],
  FACTS_EXTRACTED: ['NEEDS_CONFIRMATION', 'CATEGORY_MAPPED', 'INGESTING', 'FAILED'],
  NEEDS_CONFIRMATION: ['FACTS_EXTRACTED', 'CATEGORY_MAPPED', 'INGESTING', 'FAILED'],
  CATEGORY_MAPPED: ['CONTENT_GENERATED', 'FACTS_EXTRACTED', 'INGESTING', 'FAILED'],
  CONTENT_GENERATED: ['VALIDATED', 'FACTS_EXTRACTED', 'INGESTING', 'FAILED'],
  VALIDATED: ['NEEDS_CONFIRMATION', 'HUMAN_APPROVED', 'FACTS_EXTRACTED', 'INGESTING', 'FAILED'],
  HUMAN_APPROVED: ['EXPORTED', 'DRAFT_CREATED', 'FACTS_EXTRACTED', 'INGESTING', 'FAILED'],
  EXPORTED: [],
  DRAFT_CREATED: [],
  FAILED: ['INGESTING'],
};

export const TASK_STATE_METADATA: Record<TaskStatus, {
  label: string;
  owner: 'user' | 'agent' | 'system';
  phase: 'intake' | 'facts' | 'compile' | 'review' | 'delivery' | 'exception';
  requiresHumanAction: boolean;
  terminal: boolean;
}> = {
  CREATED: { label: '任务已创建', owner: 'user', phase: 'intake', requiresHumanAction: false, terminal: false },
  INGESTING: { label: '资料接收中', owner: 'system', phase: 'intake', requiresHumanAction: false, terminal: false },
  FILES_PARSED: { label: '源文件已解析', owner: 'agent', phase: 'intake', requiresHumanAction: false, terminal: false },
  FACTS_EXTRACTED: { label: '事实已提取', owner: 'agent', phase: 'facts', requiresHumanAction: false, terminal: false },
  NEEDS_CONFIRMATION: { label: '等待人工确认', owner: 'user', phase: 'facts', requiresHumanAction: true, terminal: false },
  CATEGORY_MAPPED: { label: '类目已匹配', owner: 'agent', phase: 'compile', requiresHumanAction: false, terminal: false },
  CONTENT_GENERATED: { label: '内容已生成', owner: 'agent', phase: 'compile', requiresHumanAction: false, terminal: false },
  VALIDATED: { label: '规则校验完成', owner: 'system', phase: 'review', requiresHumanAction: true, terminal: false },
  HUMAN_APPROVED: { label: '人工审核通过', owner: 'user', phase: 'review', requiresHumanAction: false, terminal: false },
  EXPORTED: { label: '上架包已导出', owner: 'system', phase: 'delivery', requiresHumanAction: false, terminal: true },
  DRAFT_CREATED: { label: '平台草稿已创建', owner: 'system', phase: 'delivery', requiresHumanAction: false, terminal: true },
  FAILED: { label: '任务执行失败', owner: 'system', phase: 'exception', requiresHumanAction: true, terminal: false },
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function getAllowedTransitions(status: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[status];
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return TASK_STATE_METADATA[status].terminal;
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}
