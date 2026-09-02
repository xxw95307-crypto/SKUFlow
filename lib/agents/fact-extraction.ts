import type { UnifiedParseResult } from '../domain/document-parsing';
import type {
  ExtractedCandidate,
  ExtractedFact,
  ExtractionEvidenceItem,
  FactExtractionOutput,
} from '../domain/fact-extraction';
import type { EvidenceLocator, FactValue } from '../domain/product-passport';

export const FACT_EXTRACTION_PROMPT_VERSION = 'day4-v1';
const MAX_EVIDENCE_ITEMS = 120;
const MAX_EVIDENCE_CHARACTERS = 60_000;

export const REQUIRED_FACT_DEFINITIONS = [
  { key: 'product.name', label: '商品名称' },
  { key: 'product.brand', label: '品牌' },
  { key: 'product.model', label: '型号' },
  { key: 'product.category_hint', label: '候选类目' },
  { key: 'product.description', label: '商品描述' },
  { key: 'product.material', label: '主要材质' },
  { key: 'product.color', label: '颜色' },
  { key: 'product.capacity', label: '容量' },
  { key: 'product.power', label: '额定功率' },
  { key: 'product.voltage', label: '额定电压' },
  { key: 'product.weight.net', label: '商品净重' },
  { key: 'product.dimensions', label: '商品尺寸' },
  { key: 'battery.capacity', label: '电池容量' },
  { key: 'battery.energy', label: '电池能量' },
  { key: 'package.contents', label: '包装清单' },
  { key: 'compliance.certifications', label: '认证信息' },
] as const;

export interface ExtractionContext {
  items: ExtractionEvidenceItem[];
  prompt: string;
  imageBlocksPending: number;
  omittedItems: number;
}

function locatorFor(result: UnifiedParseResult, blockIndex: number): EvidenceLocator {
  const block = result.blocks[blockIndex];
  const path = `parse.${result.id}.${block.id}`;
  if (block.type === 'text' && block.locator.page) {
    return { kind: 'PAGE', path, page: block.locator.page };
  }
  if (block.type === 'text') {
    return {
      kind: 'TEXT_LINES',
      path,
      lineStart: block.locator.lineStart,
      lineEnd: block.locator.lineEnd,
    };
  }
  if (block.type === 'table') {
    return {
      kind: 'TABLE_RANGE',
      path,
      sheet: block.locator.sheet,
      range: block.locator.range,
    };
  }
  return { kind: 'IMAGE_REGION', path };
}

function excerptFor(result: UnifiedParseResult, blockIndex: number): string {
  const block = result.blocks[blockIndex];
  if (block.type === 'text') return block.text.slice(0, 3_500);
  if (block.type === 'table') {
    const rows = [block.headers, ...block.rows].slice(0, 80);
    return rows.map((row) => row.join('\t')).join('\n').slice(0, 3_500);
  }
  return '';
}

function describeLocator(locator: EvidenceLocator): string {
  if (locator.kind === 'PAGE') return `page=${locator.page}`;
  if (locator.kind === 'TABLE_RANGE') return `sheet=${locator.sheet ?? '?'} range=${locator.range ?? '?'}`;
  if (locator.kind === 'TEXT_LINES') return `lines=${locator.lineStart ?? '?'}-${locator.lineEnd ?? '?'}`;
  return locator.path;
}

export function buildFactExtractionContext(results: UnifiedParseResult[]): ExtractionContext {
  const items: ExtractionEvidenceItem[] = [];
  let usedCharacters = 0;
  let imageBlocksPending = 0;
  let eligibleItems = 0;

  for (const result of results) {
    for (let blockIndex = 0; blockIndex < result.blocks.length; blockIndex += 1) {
      const block = result.blocks[blockIndex];
      if (block.type === 'image') {
        imageBlocksPending += 1;
        continue;
      }
      eligibleItems += 1;
      if (items.length >= MAX_EVIDENCE_ITEMS || usedCharacters >= MAX_EVIDENCE_CHARACTERS) continue;
      const excerpt = excerptFor(result, blockIndex);
      if (!excerpt) continue;
      const remaining = MAX_EVIDENCE_CHARACTERS - usedCharacters;
      const boundedExcerpt = excerpt.slice(0, remaining);
      const locator = locatorFor(result, blockIndex);
      items.push({
        ref: `E${items.length + 1}`,
        fileId: result.fileId,
        filename: result.filename,
        sourceKind: 'FILE_TEXT',
        locator,
        excerpt: boundedExcerpt,
        contentHash: result.metadata.sha256,
      });
      usedCharacters += boundedExcerpt.length;
    }
  }

  const prompt = items.map((item) => [
    `[${item.ref}] file=${JSON.stringify(item.filename)} locator=${describeLocator(item.locator)}`,
    item.excerpt,
  ].join('\n')).join('\n\n---\n\n');

  return {
    items,
    prompt,
    imageBlocksPending,
    omittedItems: Math.max(0, eligibleItems - items.length),
  };
}

function normalizeValue(value: unknown): FactValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return value;
    if (value.every((item) => typeof item === 'number' && Number.isFinite(item))) return value;
    return undefined;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length <= 20 && entries.every(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))) {
      return Object.fromEntries(entries) as Record<string, string | number | boolean>;
    }
  }
  return undefined;
}

function normalizeConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function normalizeEvidenceRefs(value: unknown, knownRefs: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && knownRefs.has(item)))].slice(0, 12);
}

function normalizeCandidate(value: unknown, knownRefs: Set<string>): ExtractedCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const factValue = normalizeValue(record.value);
  if (factValue === undefined || factValue === null) return null;
  return {
    value: factValue,
    unit: typeof record.unit === 'string' && record.unit.trim() ? record.unit.trim().slice(0, 30) : null,
    confidence: normalizeConfidence(record.confidence),
    evidenceRefs: normalizeEvidenceRefs(record.evidence_refs ?? record.evidenceRefs, knownRefs),
  };
}

function unwrapJson(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  return JSON.parse(unfenced);
}

export function parseFactExtractionOutput(content: string, evidenceItems: ExtractionEvidenceItem[]): FactExtractionOutput {
  const parsed = unwrapJson(content);
  if (!parsed || typeof parsed !== 'object') throw new Error('模型未返回 JSON 对象');
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.facts)) throw new Error('模型结果缺少 facts 数组');
  const knownRefs = new Set(evidenceItems.map((item) => item.ref));
  const factsByKey = new Map<string, ExtractedFact>();

  for (const rawFact of root.facts.slice(0, 60)) {
    if (!rawFact || typeof rawFact !== 'object') continue;
    const record = rawFact as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key.trim().toLowerCase() : '';
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(key)) continue;
    const candidate = normalizeCandidate(record, knownRefs);
    if (!candidate || candidate.evidenceRefs.length === 0) continue;
    const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim().slice(0, 80) : key;
    const alternatives = Array.isArray(record.alternatives)
      ? record.alternatives.map((item) => normalizeCandidate(item, knownRefs)).filter((item): item is ExtractedCandidate => item !== null && item.evidenceRefs.length > 0)
      : [];
    const existing = factsByKey.get(key);
    if (existing) {
      existing.alternatives.push(candidate, ...alternatives);
    } else {
      factsByKey.set(key, { key, label, ...candidate, alternatives });
    }
  }

  return {
    facts: [...factsByKey.values()].slice(0, 40),
    notes: Array.isArray(root.notes)
      ? root.notes.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 300)).slice(0, 10)
      : [],
  };
}

export function factValueKey(value: FactValue, unit: string | null): string {
  return `${JSON.stringify(value)}::${unit ?? ''}`.toLowerCase();
}

export function buildFactExtractionMessages(context: ExtractionContext): Array<{ role: 'system' | 'user'; content: string }> {
  const requiredFields = REQUIRED_FACT_DEFINITIONS.map((item) => `${item.key} (${item.label})`).join(', ');
  return [
    {
      role: 'system',
      content: [
        '你是跨境电商商品事实抽取 Agent。只根据用户提供的证据片段抽取事实，不得补充常识，不得猜测。',
        '每个非空事实必须引用至少一个真实 evidence_ref。相同字段出现不同值时，将最可信值放 value，其余放 alternatives，不要自行裁决。',
        'confidence 取 0 到 1；直接、清晰、同源一致可高，OCR 模糊或上下文间接应低。单位与数值分开。',
        '输出标准 JSON，不要输出 Markdown。结构：',
        '{"facts":[{"key":"product.capacity","label":"容量","value":380,"unit":"ml","confidence":0.96,"evidence_refs":["E1"],"alternatives":[{"value":400,"unit":"ml","confidence":0.7,"evidence_refs":["E2"]}]}],"notes":[]}',
        `优先查找这些字段，但没有证据时不要生成：${requiredFields}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请按 JSON 格式从以下证据中抽取商品事实：\n\n${context.prompt}`,
    },
  ];
}
