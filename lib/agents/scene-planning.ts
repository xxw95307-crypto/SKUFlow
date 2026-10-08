import type { ProductFact } from '../domain/product-passport';
import { MAX_SCENES, type SceneVariant } from '../domain/scene-plan.ts';

export function buildScenePlanningMessages(input: {
  productName: string;
  facts: ProductFact[];
  count: number;
  directions: string[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  return [{
    role: 'system',
    content: `你是电商商品场景策划师。为同一件真实商品设计 ${input.count} 套可区分的上新场景，每套之后会生成独立的商品图与 Listing 文案。场景可以从真实使用情境、目标人群或视觉角度切入，但绝不能把同一实物说成不同颜色、材质、功能、规格或库存。商品事实始终以资料为准。不要承诺不同链接一定获得不同流量。商家对各套的指示优先。只返回 JSON：{"scenes":[{"name":"简短中文场景名","visualBrief":"画面场景、主体、构图与氛围，必须保留商品真实外观","copyBrief":"与该画面呼应的标题、卖点和描述切入角度，不添加虚构事实"}]}。每套都要具体且有明显区别，数量必须准确，全部使用简体中文。`,
  }, {
    role: 'user',
    content: JSON.stringify({ productName: input.productName, facts: input.facts.filter((fact) => fact.value !== null && !['MISSING', 'CONFLICT'].includes(fact.status)).map((fact) => ({ label: fact.label, value: fact.value })), directions: input.directions }),
  }];
}

export function parseScenePlanningOutput(content: string, count: number): SceneVariant[] {
  if (!Number.isInteger(count) || count < 2 || count > MAX_SCENES) throw new Error(`裂变版本需为 2–${MAX_SCENES} 套`);
  const clean = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const root = JSON.parse(clean) as { scenes?: unknown };
  if (!Array.isArray(root.scenes) || root.scenes.length !== count) throw new Error('场景方案数量与所选版本数不一致');
  const scenes = root.scenes.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error('场景方案缺少内容');
    const record = value as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, 32) : '';
    const visualBrief = typeof record.visualBrief === 'string' ? record.visualBrief.trim().slice(0, 500) : '';
    const copyBrief = typeof record.copyBrief === 'string' ? record.copyBrief.trim().slice(0, 500) : '';
    if (!name || !visualBrief || !copyBrief) throw new Error(`第 ${index + 1} 套场景方案不完整`);
    return { id: `scene_${index + 1}`, name, visualBrief, copyBrief };
  });
  if (new Set(scenes.map((scene) => scene.name)).size !== count
    || new Set(scenes.map((scene) => scene.visualBrief)).size !== count
    || new Set(scenes.map((scene) => scene.copyBrief)).size !== count) throw new Error('场景方案重复，请重新规划');
  return scenes;
}
