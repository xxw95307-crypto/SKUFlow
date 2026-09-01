import type { TaskStatus } from '../domain/task';

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  CREATED: ['INGESTING', 'FAILED'],
  INGESTING: ['FACTS_EXTRACTED', 'FAILED'],
  FACTS_EXTRACTED: ['NEEDS_CONFIRMATION', 'CATEGORY_MAPPED', 'FAILED'],
  NEEDS_CONFIRMATION: ['FACTS_EXTRACTED', 'CATEGORY_MAPPED', 'FAILED'],
  CATEGORY_MAPPED: ['CONTENT_GENERATED', 'FAILED'],
  CONTENT_GENERATED: ['VALIDATED', 'FAILED'],
  VALIDATED: ['NEEDS_CONFIRMATION', 'HUMAN_APPROVED', 'FAILED'],
  HUMAN_APPROVED: ['EXPORTED', 'DRAFT_CREATED', 'FAILED'],
  EXPORTED: [],
  DRAFT_CREATED: [],
  FAILED: ['INGESTING'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}
