import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreConversationAssetSnapshots, snapshotGeneratedImages } from '../lib/agents/asset-history.ts';
import type { GeneratedAsset } from '../lib/domain/generated-asset.ts';

function image(id: string, batchId: string): GeneratedAsset {
  return {
    id, taskId: 'task_demo', sourceFileId: 'file_demo', batchId,
    kind: 'CUSTOM', title: id, note: '', model: 'image', status: 'COMPLETED',
    width: 1024, height: 1024, error: null, createdAt: '', completedAt: '',
    imageUrl: `/api/tasks/task_demo/generated-assets/${id}/file`,
  };
}

test('each generated image round stays attached to its original conversation message', () => {
  const first = image('asset_first', 'batch_first');
  const second = image('asset_second', 'batch_second');
  const messages = [
    { id: 'm1', role: 'agent' as const, text: '图片已生成', kind: 'assets' as const, meta: '等待素材选择' },
    { id: 'u1', role: 'user' as const, text: '请重新生成' },
    { id: 'm2', role: 'agent' as const, text: '图片已生成', kind: 'assets' as const, meta: '等待素材选择' },
  ];
  const result = restoreConversationAssetSnapshots(messages, [[first], [second]]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.messages.filter((message) => message.kind === 'assets').map((message) => message.assets?.[0]?.id), ['asset_first', 'asset_second']);
  assert.equal(snapshotGeneratedImages([first])[0].taskId, 'task_demo');
});

test('saved rounds are stable when older conversations are reopened', () => {
  const first = image('asset_first', 'batch_first');
  const saved = snapshotGeneratedImages([first]);
  const messages = [{ id: 'm1', role: 'agent' as const, text: '图片已生成', kind: 'assets' as const, assets: saved }];
  const result = restoreConversationAssetSnapshots(messages, [[image('asset_other', 'batch_other')]]);
  assert.equal(result.changed, false);
  assert.deepEqual(result.messages[0].assets, saved);
});
