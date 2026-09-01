import type { PlatformId } from './platform';

export const TASK_STATUSES = [
  'CREATED',
  'INGESTING',
  'FACTS_EXTRACTED',
  'NEEDS_CONFIRMATION',
  'CATEGORY_MAPPED',
  'CONTENT_GENERATED',
  'VALIDATED',
  'HUMAN_APPROVED',
  'EXPORTED',
  'DRAFT_CREATED',
  'FAILED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  CREATED: '任务已创建',
  INGESTING: '资料接收中',
  FACTS_EXTRACTED: '事实已提取',
  NEEDS_CONFIRMATION: '等待人工确认',
  CATEGORY_MAPPED: '类目已匹配',
  CONTENT_GENERATED: '内容已生成',
  VALIDATED: '规则校验完成',
  HUMAN_APPROVED: '人工审核通过',
  EXPORTED: '上架包已导出',
  DRAFT_CREATED: '平台草稿已创建',
  FAILED: '任务执行失败',
};

export interface TaskFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
  status: 'STORED';
}

export interface TaskEvent {
  id: number;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  actor: 'user' | 'system' | 'agent';
  note: string | null;
  createdAt: string;
}

export interface TaskSnapshot {
  id: string;
  productName: string;
  status: TaskStatus;
  markets: string[];
  platforms: PlatformId[];
  files: TaskFile[];
  events?: TaskEvent[];
  createdAt: string;
  updatedAt: string;
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.includes(value as TaskStatus);
}
