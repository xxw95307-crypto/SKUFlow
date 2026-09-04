import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialProductPassport } from '../lib/domain/product-passport.ts';
import { applyFactExtraction } from '../lib/server/fact-extraction-store.ts';

interface CapturedStatement {
  sql: string;
  values: unknown[];
}

function recordingDatabase(captured: CapturedStatement[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return { sql, values };
        },
      };
    },
    async batch(statements: unknown[]) {
      captured.push(...statements as CapturedStatement[]);
      return [];
    },
  } as unknown as D1Database;
}

test('model-generated product name replaces legacy user input without a missing evidenceRefs crash', async () => {
  let sequence = 0;
  const passport = createInitialProductPassport({
    taskId: 'task_auto_name',
    platforms: ['amazon'],
    markets: ['美国'],
    now: '2026-09-04T00:00:00.000Z',
    idFactory: () => `auto-name-${++sequence}`,
  });
  const legacyName = passport.facts.find((fact) => fact.key === 'product.name')!;
  legacyName.value = '用户旧名称';
  legacyName.status = 'CONFIRMED';
  legacyName.sourceKind = 'USER_INPUT';
  legacyName.confidence = 1;

  const captured: CapturedStatement[] = [];
  const summary = await applyFactExtraction(recordingDatabase(captured), {
    runId: 'run_auto_name',
    passport,
    evidenceItems: [{
      ref: 'E1',
      fileId: 'file_sheet',
      filename: '商品参数.xlsx',
      sourceKind: 'FILE_TEXT',
      locator: { kind: 'TABLE_RANGE', path: 'parse.sheet', sheet: '商品信息', range: 'A1:B10' },
      excerpt: '品名：浅粉色圆领短袖 T 恤',
      contentHash: 'abc123',
    }],
    output: {
      facts: [{
        key: 'product.name',
        label: '商品名称',
        value: '浅粉色圆领短袖 T 恤',
        unit: null,
        confidence: 0.98,
        evidenceRefs: ['E1'],
        alternatives: [{
          value: '浅粉色纯棉短袖上衣',
          unit: null,
          confidence: 0.81,
          evidenceRefs: ['E1'],
        }],
      }],
      notes: [],
    },
    usage: null,
    model: 'qwen3.8-max',
    imageBlocksPending: 0,
    now: '2026-09-04T01:00:00.000Z',
  });

  assert.equal(summary.factsExtracted, 1);
  assert.equal(summary.conflicts, 0);
  const taskNameUpdate = captured.find((statement) => statement.sql.includes('UPDATE tasks SET product_name'));
  assert.deepEqual(taskNameUpdate?.values, ['浅粉色圆领短袖 T 恤', '2026-09-04T01:00:00.000Z', 'task_auto_name']);
});
