import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssetGenerationSpec } from '../lib/agents/asset-generation.ts';
import type { callBailianImageGeneration, checkGeneratedImageAgainstIntent } from '../lib/ai/bailian-client.ts';
import { generateVerifiedImage } from '../lib/server/verified-image.ts';

const spec: AssetGenerationSpec = {
  kind: 'POSTER', title: '商品海报', note: '只展示商品', size: '1024*1280',
  instruction: '只展示衣服，不能出现模特或人物',
  acceptance: '画面是商品海报，只有衣服，没有模特或人物',
  negativePrompt: '模特、人物、真人',
};
const imageConfig = { apiKey: 'test', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-image-2.0' };
const reviewConfig = { apiKey: 'test', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max' };
const source = { bytes: new Uint8Array([1]), contentType: 'image/png' };

test('rejected images are never returned as selectable results', async () => {
  const requests: Array<{ prompt: string; negativePrompt?: string }> = [];
  const generate = (async (_config: unknown, input: { prompt: string; negativePrompt?: string }) => {
    requests.push({ prompt: input.prompt, negativePrompt: input.negativePrompt });
    return { bytes: new Uint8Array([2]), contentType: 'image/png', model: 'test', requestId: null, width: 1024, height: 1280 };
  }) as typeof callBailianImageGeneration;
  const review = (async () => ({ matches: false, reason: '画面仍有模特' })) as typeof checkGeneratedImageAgainstIntent;
  await assert.rejects(
    generateVerifiedImage(imageConfig, reviewConfig, source, spec, '商品海报', '只展示衣服，不要模特', source, [], { generate, review }),
    /连续三次未通过画面验收/,
  );
  assert.equal(requests.length, 3);
  assert.equal(requests[0].negativePrompt, '模特、人物、真人');
  assert.match(requests[1].prompt, /画面仍有模特/);
});

test('a corrected image is returned only after review passes', async () => {
  let attempts = 0;
  const generate = (async () => {
    attempts += 1;
    return { bytes: new Uint8Array([attempts]), contentType: 'image/png', model: 'test', requestId: null, width: 1024, height: 1280 };
  }) as typeof callBailianImageGeneration;
  const review = (async () => ({ matches: attempts === 2, reason: attempts === 1 ? '画面有模特' : '' })) as typeof checkGeneratedImageAgainstIntent;
  const result = await generateVerifiedImage(imageConfig, reviewConfig, source, spec, '商品海报', '只展示衣服，不要模特', source, [], { generate, review });
  assert.equal(attempts, 2);
  assert.deepEqual([...result.generated.bytes], [2]);
  assert.equal(result.reviewWarning, null);
});
