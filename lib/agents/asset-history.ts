import type { ConversationAssetSnapshot, ConversationMessage } from '../domain/conversation.ts';
import type { GeneratedAsset } from '../domain/generated-asset.ts';

export function snapshotGeneratedImages(assets: readonly GeneratedAsset[]): ConversationAssetSnapshot[] {
  return assets.filter((asset) => asset.kind !== 'VIDEO' && asset.status === 'COMPLETED').map((asset) => ({
    id: asset.id, taskId: asset.taskId, kind: asset.kind, title: asset.title,
    width: asset.width, height: asset.height, error: asset.error,
  }));
}

export function restoreConversationAssetSnapshots(
  messages: readonly ConversationMessage[],
  batches: readonly (readonly GeneratedAsset[])[],
): { messages: ConversationMessage[]; changed: boolean } {
  let batchIndex = 0;
  let changed = false;
  let previous: ConversationAssetSnapshot[] = [];
  const restored = messages.map((message) => {
    if (message.kind !== 'assets') return message;
    if (message.assets?.length) {
      previous = message.assets;
      const matchingIndex = batches.findIndex((batch, index) => index >= batchIndex && batch.some((asset) => asset.id === message.assets![0].id));
      if (matchingIndex >= 0) batchIndex = matchingIndex + 1;
      return message;
    }
    const batch = message.text.startsWith('已找到保存的候选图片') && previous.length
      ? previous
      : snapshotGeneratedImages(batches[batchIndex++] ?? []);
    if (!batch.length) return message;
    previous = batch;
    changed = true;
    return { ...message, assets: batch };
  });
  return { messages: restored, changed };
}
