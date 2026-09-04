import type { UnifiedParseResult } from '../domain/document-parsing';
import type {
  ExtractedCandidate,
  ExtractedFact,
  ExtractionEvidenceItem,
  FactExtractionOutput,
} from '../domain/fact-extraction';
import type { EvidenceLocator, FactValue } from '../domain/product-passport';
import {
  isStableProductAttributeKey,
  normalizeProductAttributeKey,
  PRODUCT_ATTRIBUTE_DEFINITIONS,
  productAttributeLabel,
} from '../domain/product-attributes.ts';
import type { VisionAgentRun } from '../domain/vision-analysis';

export const FACT_EXTRACTION_PROMPT_VERSION = 'day4-v2';
const MAX_EVIDENCE_ITEMS = 120;
const MAX_EVIDENCE_CHARACTERS = 60_000;

export const REQUIRED_FACT_DEFINITIONS = PRODUCT_ATTRIBUTE_DEFINITIONS.filter((definition) => definition.required);

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

export function buildFactExtractionContext(
  results: UnifiedParseResult[],
  visionRuns: readonly VisionAgentRun[] = [],
): ExtractionContext {
  const items: ExtractionEvidenceItem[] = [];
  let usedCharacters = 0;
  let imageBlocksPending = 0;
  let eligibleItems = 0;
  const completedVisionFileIds = new Set(
    visionRuns.filter((run) => run.status === 'COMPLETED' && run.result).map((run) => run.fileId),
  );

  for (const result of results) {
    for (let blockIndex = 0; blockIndex < result.blocks.length; blockIndex += 1) {
      const block = result.blocks[blockIndex];
      if (block.type === 'image') {
        if (!completedVisionFileIds.has(result.fileId)) imageBlocksPending += 1;
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

  const filenameByFileId = new Map(results.map((result) => [result.fileId, result.filename]));
  const appendVisionItem = (
    run: VisionAgentRun,
    path: string,
    excerpt: string,
    bbox?: [number, number, number, number],
  ) => {
    eligibleItems += 1;
    if (!excerpt || items.length >= MAX_EVIDENCE_ITEMS || usedCharacters >= MAX_EVIDENCE_CHARACTERS) return;
    const remaining = MAX_EVIDENCE_CHARACTERS - usedCharacters;
    const boundedExcerpt = excerpt.slice(0, remaining);
    items.push({
      ref: `E${items.length + 1}`,
      fileId: run.fileId,
      filename: filenameByFileId.get(run.fileId) ?? '商品图片',
      sourceKind: 'VISION',
      locator: { kind: 'IMAGE_REGION', path, ...(bbox ? { bbox } : {}) },
      excerpt: boundedExcerpt,
      contentHash: run.inputHash,
    });
    usedCharacters += boundedExcerpt.length;
  };

  for (const run of visionRuns) {
    if (run.status !== 'COMPLETED' || !run.result) continue;
    appendVisionItem(run, `vision.${run.id}.summary`, run.result.summary);
    appendVisionItem(run, `vision.${run.id}.visible_text`, run.result.visibleText);
    run.result.facts.forEach((fact, index) => appendVisionItem(
      run,
      `vision.${run.id}.facts.${index}`,
      `视觉字段 ${fact.key}（${fact.label}）：${JSON.stringify(fact.value)}${fact.unit ? ` ${fact.unit}` : ''}；视觉置信度 ${fact.confidence}`,
      fact.bbox ?? undefined,
    ));
  }

  const prompt = items.map((item) => [
    `[${item.ref}] source=${item.sourceKind} file=${JSON.stringify(item.filename)} locator=${describeLocator(item.locator)}`,
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
    const key = typeof record.key === 'string' ? normalizeProductAttributeKey(record.key) : '';
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(key)) continue;
    if (!isStableProductAttributeKey(key)) continue;
    const candidate = normalizeCandidate(record, knownRefs);
    if (!candidate || candidate.evidenceRefs.length === 0) continue;
    const rawLabel = typeof record.label === 'string' && record.label.trim() ? record.label.trim().slice(0, 80) : key;
    const label = productAttributeLabel(key, rawLabel);
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
  const normalizedUnit = (unit ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const numericValue = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  if (numericValue !== null) {
    if (['l', 'liter', 'litre', '升'].includes(normalizedUnit)) return `${numericValue * 1_000}::ml`;
    if (['ml', 'milliliter', 'millilitre', '毫升'].includes(normalizedUnit)) return `${numericValue}::ml`;
    if (['kg', '千克', '公斤'].includes(normalizedUnit)) return `${numericValue * 1_000}::g`;
    if (['g', 'gram', '克'].includes(normalizedUnit)) return `${numericValue}::g`;
    return `${numericValue}::${normalizedUnit}`;
  }
  return `${JSON.stringify(value)}::${normalizedUnit}`.toLowerCase();
}

export function buildFactExtractionMessages(context: ExtractionContext): Array<{ role: 'system' | 'user'; content: string }> {
  const canonicalFields = PRODUCT_ATTRIBUTE_DEFINITIONS.map((item) => `${item.key} (${item.label})`).join(', ');
  return [
    {
      role: 'system',
      content: [
        '你是跨境电商多源商品属性抽取 Agent。本任务中的全部图片、PDF、表格和文本都属于同一个商品，不需要判断文件属于哪个商品。',
        '只根据用户提供的证据片段抽取稳定商品属性，不得补充常识，不得猜测。价格、折扣、销量、店铺名称和页面按钮不是稳定商品属性，不要输出。',
        '必须综合图片与文档证据生成一个简短、客观的 product.name（商品名称），例如“浅粉色圆领短袖 T 恤”；不要加入促销词、平台关键词或没有证据的规格。',
        '每个非空事实必须引用至少一个真实 evidence_ref。必须比较 source=VISION 的图片证据与 source=FILE_TEXT 的文档证据。',
        '同一字段出现不同值时，必须把各自值及各自 evidence_ref 分别保留：将一个候选放 value，其余全部放 alternatives，绝对不要自行裁决或平均。',
        '表达不同但含义相同的值应先归一化，例如 0.38 L 与 380 ml 是同一容量，不应制造冲突。可见数量只有在结构清晰可数时才采用；被遮挡时降低 confidence。',
        'confidence 取 0 到 1；直接、清晰、同源一致可高，OCR 模糊或上下文间接应低。单位与数值分开。',
        '输出标准 JSON，不要输出 Markdown。结构：',
        '{"facts":[{"key":"product.capacity","label":"容量","value":380,"unit":"ml","confidence":0.96,"evidence_refs":["E1"],"alternatives":[{"value":400,"unit":"ml","confidence":0.7,"evidence_refs":["E2"]}]}],"notes":[]}',
        `优先使用以下规范字段名；没有证据时不要生成：${canonicalFields}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请按 JSON 格式从以下证据中抽取商品事实：\n\n${context.prompt}`,
    },
  ];
}
