import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFactExtractionContext, buildFactExtractionMessages, factValueKey, parseFactExtractionOutput } from '../lib/agents/fact-extraction.ts';
import { callBailianFactExtraction } from '../lib/ai/bailian-client.ts';
import { loadBailianConfig, missingBailianConfig } from '../lib/config/bailian.ts';
import type { UnifiedParseResult } from '../lib/domain/document-parsing.ts';

function parseResult(): UnifiedParseResult {
  return {
    id: 'parse_1',
    schemaVersion: '1.0',
    taskId: 'task_1',
    fileId: 'file_1',
    filename: '参数表.pdf',
    contentType: 'application/pdf',
    parserKind: 'PDF',
    status: 'COMPLETED',
    text: '额定容量 380 ml\n额定功率 70 W',
    blocks: [
      { id: 'block_1', type: 'text', text: '额定容量 380 ml\n额定功率 70 W', locator: { sourceRef: 'file_1', page: 2 } },
      { id: 'block_2', type: 'image', format: 'PNG', width: 800, height: 800, altText: null, locator: { sourceRef: 'file_1' } },
    ],
    metadata: { byteSize: 100, sha256: 'abc123', characterCount: 24, blockCount: 2, pageCount: 2 },
    warnings: [],
    error: null,
    startedAt: '2026-09-04T00:00:00.000Z',
    completedAt: '2026-09-04T00:00:00.000Z',
  };
}

test('builds auditable evidence refs and leaves image blocks for a multimodal model', () => {
  const context = buildFactExtractionContext([parseResult()]);
  assert.equal(context.items.length, 1);
  assert.equal(context.items[0].ref, 'E1');
  assert.equal(context.items[0].locator.kind, 'PAGE');
  assert.equal(context.items[0].locator.page, 2);
  assert.equal(context.imageBlocksPending, 1);
  assert.match(context.prompt, /额定容量 380 ml/);
  assert.match(context.prompt, /source=FILE_TEXT/);
});

test('normalizes model facts, evidence refs and conflict candidates', () => {
  const context = buildFactExtractionContext([parseResult()]);
  const output = parseFactExtractionOutput(JSON.stringify({
    facts: [{
      key: 'product.capacity',
      label: '容量',
      value: 380,
      unit: 'ml',
      confidence: 1.2,
      evidence_refs: ['E1', 'E404'],
      alternatives: [{ value: 400, unit: 'ml', confidence: 0.6, evidence_refs: ['E1'] }],
    }],
    notes: ['参数存在两个候选值'],
  }), context.items);
  assert.equal(output.facts.length, 1);
  assert.equal(output.facts[0].confidence, 1);
  assert.deepEqual(output.facts[0].evidenceRefs, ['E1']);
  assert.equal(output.facts[0].alternatives[0].value, 400);
});

test('normalizes blade aliases and requires image-document conflicts to remain separate', () => {
  const context = buildFactExtractionContext([parseResult()]);
  const output = parseFactExtractionOutput(JSON.stringify({
    facts: [{
      key: 'blade_count',
      label: '叶片数量',
      value: 4,
      unit: '片',
      confidence: 0.94,
      evidence_refs: ['E1'],
      alternatives: [{ value: 6, unit: '片', confidence: 0.99, evidence_refs: ['E1'] }],
    }],
    notes: [],
  }), context.items);
  assert.equal(output.facts[0].key, 'product.blade_count');
  assert.equal(output.facts[0].label, '刀片数量');
  assert.equal(output.facts[0].alternatives[0].value, 6);

  const messages = buildFactExtractionMessages(context);
  assert.match(messages[0].content, /全部图片、PDF、表格和文本都属于同一个商品/);
  assert.match(messages[0].content, /必须比较 source=VISION.*source=FILE_TEXT/);
  assert.match(messages[0].content, /product\.blade_count/);
});

test('treats equivalent capacity and weight units as the same candidate value', () => {
  assert.equal(factValueKey(0.38, 'L'), factValueKey(380, 'ml'));
  assert.equal(factValueKey('0.5', 'kg'), factValueKey(500, 'g'));
  assert.notEqual(factValueKey(4, '片'), factValueKey(6, '片'));
});

test('loads all Bailian settings from the runtime environment without source defaults', () => {
  const complete = loadBailianConfig({
    BAILIAN_API_KEY: ' secret ',
    BAILIAN_BASE_URL: ' https://example.aliyuncs.com/v1 ',
    BAILIAN_MODEL: ' qwen3.8-max ',
  });
  assert.deepEqual(complete, {
    apiKey: 'secret',
    baseUrl: 'https://example.aliyuncs.com/v1',
    model: 'qwen3.8-max',
  });
  assert.deepEqual(missingBailianConfig(complete), []);
  assert.deepEqual(missingBailianConfig(loadBailianConfig({})), [
    'BAILIAN_API_KEY',
    'BAILIAN_BASE_URL',
    'BAILIAN_MODEL',
  ]);
});

test('calls the Bailian OpenAI-compatible endpoint with JSON mode and no thinking', async () => {
  const context = buildFactExtractionContext([parseResult()]);
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const response = await callBailianFactExtraction({
    apiKey: 'test-secret',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
  }, context, async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return Response.json({
      id: 'request_1',
      model: 'qwen3.8-max',
      choices: [{ message: { content: JSON.stringify({
        facts: [{ key: 'product.power', label: '额定功率', value: 70, unit: 'W', confidence: 0.98, evidence_refs: ['E1'], alternatives: [] }],
        notes: [],
      }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    });
  });
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.match(capturedUrl, /\/chat\/completions$/);
  assert.equal((capturedInit?.headers as Record<string, string>).authorization, 'Bearer test-secret');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.enable_thinking, false);
  assert.equal(response.output.facts[0].value, 70);
  assert.equal(response.usage?.total_tokens, 130);
});
