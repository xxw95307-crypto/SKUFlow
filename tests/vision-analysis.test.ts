import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFactExtractionContext } from '../lib/agents/fact-extraction.ts';
import { parseVisionAnalysisOutput } from '../lib/agents/vision-analysis.ts';
import { callBailianVisionAnalysis } from '../lib/ai/bailian-client.ts';
import { loadBailianConfig, missingBailianConfig } from '../lib/config/bailian.ts';
import type { UnifiedParseResult } from '../lib/domain/document-parsing.ts';
import type { VisionAgentRun } from '../lib/domain/vision-analysis.ts';

test('uses the same Bailian model configuration for text and image understanding', () => {
  const config = loadBailianConfig({
    BAILIAN_API_KEY: ' shared-key ',
    BAILIAN_BASE_URL: ' https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 ',
    BAILIAN_MODEL: ' qwen3.8-max ',
  });
  assert.deepEqual(config, {
    apiKey: 'shared-key',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
  });
  assert.deepEqual(missingBailianConfig(config), []);
  assert.deepEqual(missingBailianConfig(loadBailianConfig({})), [
    'BAILIAN_API_KEY',
    'BAILIAN_BASE_URL',
    'BAILIAN_MODEL',
  ]);
});

test('normalizes visual facts, OCR text and normalized image boxes', () => {
  const output = parseVisionAnalysisOutput(JSON.stringify({
    summary: '白色便携式搅拌机包装正面',
    visible_text: 'BlendGo 380ml',
    facts: [
      { key: 'product.brand', label: '品牌', value: 'BlendGo', confidence: 1.2, bbox: [-5, 10, 1100, 220] },
      { key: 'product.brand', label: '品牌', value: 'Lower confidence', confidence: 0.2, bbox: null },
      { key: 'invalid key', value: 'ignored' },
    ],
    warnings: ['侧面文字不清晰'],
  }));

  assert.equal(output.facts.length, 1);
  assert.equal(output.facts[0].value, 'BlendGo');
  assert.equal(output.facts[0].confidence, 1);
  assert.deepEqual(output.facts[0].bbox, [0, 10, 1000, 220]);
  assert.equal(output.visibleText, 'BlendGo 380ml');
});

test('sends a private Base64 image through the OpenAI-compatible vision request', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const response = await callBailianVisionAnalysis({
    apiKey: 'test-key',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
  }, {
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    contentType: 'image/jpeg',
    filename: 'product.jpg',
    productName: 'BlendGo Mini',
  }, (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: 'vision-request',
      model: 'qwen3.8-max',
      choices: [{ message: { content: JSON.stringify({ summary: '商品图', visible_text: '', facts: [], warnings: [] }) } }],
      usage: { total_tokens: 42 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);

  const messages = requestBody?.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
  assert.equal(requestBody?.model, 'qwen3.8-max');
  assert.deepEqual(requestBody?.response_format, { type: 'json_object' });
  assert.equal(requestBody?.enable_thinking, false);
  assert.match(messages[0].content[0].image_url?.url ?? '', /^data:image\/jpeg;base64,/);
  assert.equal(response.output.summary, '商品图');
  assert.equal(response.usage?.total_tokens, 42);
});

test('turns a completed Vision Agent run into citable VISION evidence', () => {
  const parseResult: UnifiedParseResult = {
    id: 'parse_1', schemaVersion: '1.0', taskId: 'task_1', fileId: 'file_1', filename: 'product.jpg',
    contentType: 'image/jpeg', parserKind: 'IMAGE', status: 'COMPLETED', text: '',
    blocks: [{ id: 'block_1', type: 'image', format: 'JPEG', width: 1000, height: 1000, altText: null, locator: { sourceRef: 'file_1' } }],
    metadata: { byteSize: 4, sha256: 'source-hash', characterCount: 0, blockCount: 1 },
    warnings: [], error: null, startedAt: '2026-09-03T00:00:00.000Z', completedAt: '2026-09-03T00:00:01.000Z',
  };
  const visionRun: VisionAgentRun = {
    id: 'vision_1', taskId: 'task_1', passportId: 'passport_1', fileId: 'file_1', provider: 'BAILIAN',
    model: 'qwen3.8-max', promptVersion: 'vision-v1', status: 'COMPLETED', inputHash: 'source-hash',
    result: {
      summary: '商品包装图', visibleText: 'BlendGo', warnings: [],
      facts: [{ key: 'product.brand', label: '品牌', value: 'BlendGo', unit: null, confidence: 0.98, bbox: [100, 100, 500, 220] }],
    },
    usage: null, error: null, createdAt: '2026-09-03T00:00:00.000Z', completedAt: '2026-09-03T00:00:01.000Z',
  };

  const context = buildFactExtractionContext([parseResult], [visionRun]);
  assert.equal(context.imageBlocksPending, 0);
  assert.equal(context.items.length, 3);
  assert.ok(context.items.every((item) => item.sourceKind === 'VISION'));
  assert.deepEqual(context.items[2].locator.bbox, [100, 100, 500, 220]);
  assert.match(context.prompt, /product\.brand/);
});
