export interface SceneVariant {
  id: string;
  name: string;
  visualBrief: string;
  copyBrief: string;
  imageCount?: number;
}

export interface ScenePlan {
  mode: 'SINGLE' | 'SPLIT';
  scenes: SceneVariant[];
  confirmedAt: string;
}

export const MAX_SCENES = 6;

export function sceneLabel(sceneId: string, plan: ScenePlan | null): string {
  return plan?.scenes.find((scene) => scene.id === sceneId)?.name ?? (sceneId === 'base' ? '常规上新' : sceneId);
}

export function parseScenePlan(raw: string | null): ScenePlan | null {
  if (!raw) return null;
  try {
    const plan = JSON.parse(raw) as ScenePlan;
    if ((plan.mode !== 'SINGLE' && plan.mode !== 'SPLIT') || !Array.isArray(plan.scenes)) return null;
    if (!plan.scenes.every((scene) => typeof scene.id === 'string' && typeof scene.name === 'string'
      && typeof scene.visualBrief === 'string' && typeof scene.copyBrief === 'string'
      && (scene.imageCount === undefined || (Number.isInteger(scene.imageCount) && scene.imageCount >= 1 && scene.imageCount <= 6)))) return null;
    return plan;
  } catch { return null; }
}
