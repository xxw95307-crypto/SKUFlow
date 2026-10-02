import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreConversationVideoRounds } from '../lib/agents/video-history.ts';
import type { ConversationMessage } from '../lib/domain/conversation.ts';

test('restores older video jobs as separate conversation rounds and preserves confirmation order', () => {
  const messages: ConversationMessage[] = [
    { id: 'prompt-1', role: 'user', text: '生成一条视频' },
    { id: 'agent-1', role: 'agent', text: '', meta: '等待视频确认' },
    { id: 'prompt-2', role: 'user', text: '重新生成' },
    { id: 'agent-2', role: 'agent', text: '', meta: '等待视频确认' },
    { id: 'confirmed', role: 'user', text: '确认', meta: '视频阶段已完成' },
  ];
  const jobs = [
    { id: 'video_3', status: 'SUCCEEDED' },
    { id: 'video_2', status: 'SUCCEEDED' },
    { id: 'video_failed', status: 'FAILED' },
    { id: 'video_1', status: 'SUCCEEDED' },
  ];
  const result = restoreConversationVideoRounds(messages, jobs);
  assert.equal(result.changed, true);
  assert.deepEqual(result.messages.filter((message) => message.kind === 'video').map((message) => message.videoJobIds), [
    ['video_1'], ['video_2'], ['video_3'],
  ]);
  assert.equal(result.messages.at(-1)?.id, 'confirmed');
  assert.equal(restoreConversationVideoRounds(result.messages, jobs).changed, false);
});

test('does not duplicate video jobs already attached to a message', () => {
  const messages: ConversationMessage[] = [
    { id: 'agent-1', role: 'agent', text: '', kind: 'video', videoJobIds: ['video_1'] },
  ];
  const result = restoreConversationVideoRounds(messages, [{ id: 'video_1', status: 'SUCCEEDED' }]);
  assert.deepEqual(result.messages, messages);
});
