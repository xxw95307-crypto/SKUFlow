import type { ConversationMessage } from '../domain/conversation.ts';

export interface SavedVideoJob {
  id: string;
  status: string;
}

// Older conversations kept video jobs only in the task. Attach them to their
// original video checkpoints where possible, then preserve any remaining jobs
// as separate rounds ahead of the final video confirmation.
export function restoreConversationVideoRounds(
  messages: readonly ConversationMessage[],
  newestFirstJobs: readonly SavedVideoJob[],
): { messages: ConversationMessage[]; changed: boolean } {
  const recorded = new Set(messages.flatMap((message) => message.videoJobIds ?? []));
  const missing = newestFirstJobs.filter((job) => job.status === 'SUCCEEDED' && !recorded.has(job.id)).reverse();
  if (!missing.length) return { messages: [...messages], changed: false };

  const restored = [...messages];
  let nextJob = 0;
  for (let index = 0; index < restored.length && nextJob < missing.length; index += 1) {
    const message = restored[index];
    if (message.role !== 'agent' || message.meta !== '等待视频确认' || message.videoJobIds?.length) continue;
    restored[index] = { ...message, kind: 'video', videoJobIds: [missing[nextJob++].id] };
  }
  if (nextJob < missing.length) {
    const confirmationIndex = restored.findIndex((message) => message.role === 'user' && message.meta === '视频阶段已完成');
    const insertionIndex = confirmationIndex < 0 ? restored.length : confirmationIndex;
    restored.splice(insertionIndex, 0, ...missing.slice(nextJob).map((job): ConversationMessage => ({
      id: `restored_${job.id}`, role: 'agent', text: '', meta: '等待视频确认', kind: 'video', videoJobIds: [job.id],
    })));
  }
  return { messages: restored.slice(-200), changed: true };
}
