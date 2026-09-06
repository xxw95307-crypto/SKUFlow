import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSET_GENERATION_SPECS, buildAssetGenerationPrompt } from '../lib/agents/asset-generation.ts';
import { callBailianImageGeneration } from '../lib/ai/bailian-client.ts';
import { loadBailianImageConfig, missingBailianImageConfig } from '../lib/config/bailian.ts';
import type { ProductFact } from '../lib/domain/product-passport.ts';

test('loads a separate image model while reusing the shared Bailian key and base address', () => {
  const config = loadBailianImageConfig({
    BAILIAN_API_KEY: ' shared ',
    BAILIAN_BASE_URL: ' https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 ',
    BAILIAN_IMAGE_MODEL: ' qwen-image-2.0 ',
  });
  assert.deepEqual(config, {
    apiKey: 'shared',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-image-2.0',
  });
  assert.deepEqual(missingBailianImageConfig(config), []);
  assert.deepEqual(missingBailianImageConfig(loadBailianImageConfig({})), [
    'BAILIAN_API_KEY', 'BAILIAN_BASE_URL', 'BAILIAN_IMAGE_MODEL',
  ]);
});

test('builds source-grounded prompts without asking the image model to invent claims', () => {
  const facts: ProductFact[] = [{
    id: 'fact_1', key: 'product.color', label: '颜色',
    value: '浅粉色', unit: null, status: 'CONFIRMED', confidence: 1, sourceKind: 'USER_INPUT',
    evidenceIds: [], createdAt: '', updatedAt: '',
  }];
  const prompt = buildAssetGenerationPrompt({
    spec: ASSET_GENERATION_SPECS[0], productName: '浅粉色圆领短袖T恤', facts, listings: [],
  });
  assert.match(prompt, /真实商品作为唯一主体/);
  assert.match(prompt, /颜色：浅粉色/);
  assert.match(prompt, /不得添加资料没有支持的配件、功能、认证/);
});

test('calls the Token Plan native image endpoint with a private reference image and downloads the result', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/multimodal-generation/generation')) {
      return Response.json({
        request_id: 'image_req_1',
        output: { choices: [{ message: { content: [{ image: 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/generated.png' }] } }] },
        usage: { image_count: 1, width: 1024, height: 1024 },
      });
    }
    return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const result = await callBailianImageGeneration({
    apiKey: 'test-key', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen-image-2.0',
  }, {
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg', prompt: '生成商品主图', size: '1024*1024',
  }, fetchMock);
  assert.equal(calls[0].url, 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  const body = JSON.parse(String(calls[0].init?.body)) as { model: string; input: { messages: Array<{ content: Array<{ image?: string }> }> }; parameters: { watermark: boolean } };
  assert.equal(body.model, 'qwen-image-2.0');
  assert.match(body.input.messages[0].content[0].image ?? '', /^data:image\/jpeg;base64,/);
  assert.equal(body.parameters.watermark, false);
  assert.deepEqual([...result.bytes], [137, 80, 78, 71]);
  assert.equal(result.width, 1024);
});
