import type { FactValue } from '../domain/product-passport';
import {
  isStableProductAttributeKey,
  normalizeProductAttributeKey,
  PRODUCT_ATTRIBUTE_DEFINITIONS,
  productAttributeLabel,
} from '../domain/product-attributes.ts';
import type { NormalizedImageBox, VisionAnalysisOutput, VisionFactObservation } from '../domain/vision-analysis';

export const VISION_ANALYSIS_PROMPT_VERSION = 'vision-v2';

export interface VisionPromptContext {
  filename: string;
  productName: string;
}

function normalizeValue(value: unknown): Exclude<FactValue, null> | undefined {
  if (typeof value === 'string') return value.trim().slice(0, 5_000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return value.map((item) => item.slice(0, 500)).slice(0, 40);
    if (value.every((item) => typeof item === 'number' && Number.isFinite(item))) return value.slice(0, 40);
    return undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
    if (entries.every(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))) {
      return Object.fromEntries(entries.map(([key, item]) => [key.slice(0, 80), item])) as Record<string, string | number | boolean>;
    }
  }
  return undefined;
}

function normalizeConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function normalizeBox(value: unknown): NormalizedImageBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map(Number);
  if (!numbers.every(Number.isFinite)) return null;
  const box = numbers.map((number) => Math.round(Math.min(1_000, Math.max(0, number)))) as NormalizedImageBox;
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

function unwrapJson(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  return JSON.parse(unfenced);
}

export function parseVisionAnalysisOutput(content: string): VisionAnalysisOutput {
  const parsed = unwrapJson(content);
  if (!parsed || typeof parsed !== 'object') throw new Error('视觉模型未返回 JSON 对象');
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.facts)) throw new Error('视觉模型结果缺少 facts 数组');
  const factsByKey = new Map<string, VisionFactObservation>();

  for (const rawFact of root.facts.slice(0, 60)) {
    if (!rawFact || typeof rawFact !== 'object') continue;
    const record = rawFact as Record<string, unknown>;
    const key = typeof record.key === 'string' ? normalizeProductAttributeKey(record.key) : '';
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(key)) continue;
    if (!isStableProductAttributeKey(key)) continue;
    const value = normalizeValue(record.value);
    if (value === undefined || value === '') continue;
    const candidate: VisionFactObservation = {
      key,
      label: productAttributeLabel(
        key,
        typeof record.label === 'string' && record.label.trim() ? record.label.trim().slice(0, 80) : key,
      ),
      value,
      unit: typeof record.unit === 'string' && record.unit.trim() ? record.unit.trim().slice(0, 30) : null,
      confidence: normalizeConfidence(record.confidence),
      bbox: normalizeBox(record.bbox),
    };
    const existing = factsByKey.get(key);
    if (!existing || candidate.confidence > existing.confidence) factsByKey.set(key, candidate);
  }

  return {
    summary: typeof root.summary === 'string' ? root.summary.trim().slice(0, 2_000) : '',
    visibleText: typeof (root.visible_text ?? root.visibleText) === 'string'
      ? String(root.visible_text ?? root.visibleText).trim().slice(0, 20_000)
      : '',
    facts: [...factsByKey.values()].slice(0, 40),
    warnings: Array.isArray(root.warnings)
      ? root.warnings.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 300)).slice(0, 10)
      : [],
  };
}

export function buildVisionAnalysisPrompt(context: VisionPromptContext): string {
  const canonicalFields = PRODUCT_ATTRIBUTE_DEFINITIONS.map((item) => `${item.key} (${item.label})`).join(', ');
  return [
    '你是跨境电商图片商品属性抽取 Agent。本任务的全部图片和文档都属于同一个商品。',
    '只报告图片中直接可见或可读的稳定商品属性，不使用常识补全，不猜测看不见的规格。价格、折扣、销量、店铺信息和界面按钮不要作为商品属性输出。',
    `任务商品名称仅作为检索提示：${JSON.stringify(context.productName)}。如果图片与名称不一致，以图片为准并写入 warnings。`,
    `源文件：${JSON.stringify(context.filename)}。`,
    '提取包装文字、品牌、型号、品名、颜色、材质、容量、功率、电压、尺寸、重量、电池、包装清单、认证标识以及清晰可见的物理结构。',
    '例如刀片清晰可数时使用 product.blade_count；若有遮挡，只能描述可见数量并降低置信度，不能断言总数。没有证据的字段不要生成。',
    `尽量使用以下规范字段名：${canonicalFields}`,
    'bbox 使用 [x1,y1,x2,y2]，坐标归一化到 0–1000；无法定位或依据为整张图时填 null。confidence 范围为 0–1。',
    '请输出标准 JSON，不要输出 Markdown。必须符合：',
    '{"summary":"图片整体描述","visible_text":"按阅读顺序记录可见文字","facts":[{"key":"product.brand","label":"品牌","value":"示例","unit":null,"confidence":0.95,"bbox":[100,100,400,220]}],"warnings":[]}',
  ].join('\n');
}
