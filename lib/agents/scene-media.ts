export function mediaIdsForScene(
  orderedIds: readonly string[],
  candidates: readonly { id: string; sceneId: string; type: 'IMAGE' | 'VIDEO' }[],
  sceneId: string,
  split: boolean,
): string[] {
  if (!split) return [...orderedIds];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const ownImages = orderedIds.filter((id) => {
    const candidate = byId.get(id);
    return candidate?.type === 'IMAGE' && candidate.sceneId === sceneId;
  });
  if (!ownImages.length) throw new Error(`场景 ${sceneId} 缺少已选择的对应图片`);
  return ownImages;
}
