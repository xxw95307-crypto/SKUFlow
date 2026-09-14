import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAssetGenerationPrompt, buildAssetPlanningMessages, parseUnifiedVideoDecision, parseAssetPlan } from '../lib/agents/asset-generation.ts';
import { callBailianAssetPlanning, callBailianImageGeneration } from '../lib/ai/bailian-client.ts';
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

const facts: ProductFact[] = [{
    id: 'fact_1', key: 'product.color', label: '颜色',
    value: '浅粉色', unit: null, status: 'CONFIRMED', confidence: 1, sourceKind: 'USER_INPUT',
    evidenceIds: [], createdAt: '', updatedAt: '',
}];

test('asks the planning Agent to choose category-specific assets and includes seller guidance', () => {
  const messages = buildAssetPlanningMessages({
    productName: '浅粉色圆领短袖T恤', facts, listings: [], platforms: ['amazon', 'shopify'], markets: ['美国'],
    sourceImageCount: 3, userGuidance: '希望增加一张户外通勤穿搭图',
  });
  assert.match(messages[0].content, /总数由你判断，必须为 2–4 张/);
  assert.match(messages[0].content, /必须且只能有一张 HERO/);
  assert.match(messages[1].content, /Amazon|amazon/);
  assert.match(messages[1].content, /3 张/);
  assert.match(messages[1].content, /户外通勤穿搭图/);
});

test('accepts a dynamic plan and rejects plans without exactly one main image', () => {
  const value = JSON.stringify({ assets: [
    { kind: 'HERO', title: '平台商品主图', note: '清楚展示商品正面', size: '1024*1024', instruction: '纯净背景正面平铺，柔和光线。' },
    { kind: 'MODEL', title: '通勤穿搭图', note: '展示真实穿着效果', size: '1024*1280', instruction: '成年模特在自然通勤场景穿着参考商品。' },
    { kind: 'DETAIL', title: '面料细节图', note: '突出已确认的棉质纹理', size: '1024*1024', instruction: '微距拍摄面料纹理与领口走线。' },
  ] });
  const plan = parseAssetPlan(value);
  assert.deepEqual(plan.map((item) => item.kind), ['HERO', 'MODEL', 'DETAIL']);
  assert.throws(() => parseAssetPlan(JSON.stringify({ assets: [
    { kind: 'MODEL', title: '模特图', note: '展示穿着', size: '1024*1280', instruction: '模特穿着商品。' },
    { kind: 'DETAIL', title: '细节图', note: '展示细节', size: '1024*1024', instruction: '商品细节。' },
  ] })), /必须且只能规划一张商品主图/);
});

test('calls the text model to plan assets in JSON mode', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({
      id: 'plan_req_1', model: 'qwen3.8-max',
      choices: [{ message: { content: JSON.stringify({ assets: [
        { kind: 'HERO', title: '商品主图', note: '平台首图', size: '1024*1024', instruction: '正面商品主图。' },
        { kind: 'LIFESTYLE', title: '通勤场景', note: '展示使用氛围', size: '1024*1280', instruction: '户外通勤场景。' },
      ] }) } }],
    });
  };
  const result = await callBailianAssetPlanning({
    apiKey: 'test-key', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max',
  }, {
    productName: '浅粉色圆领短袖T恤', facts, listings: [], platforms: ['amazon'], markets: ['美国'], sourceImageCount: 1,
  }, fetchMock);
  assert.equal(calls[0].url, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  const body = JSON.parse(String(calls[0].init?.body)) as { response_format: { type: string }; enable_thinking: boolean; messages: unknown[] };
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.enable_thinking, false);
  assert.equal(result.assets.length, 2);
});

test('builds source-grounded prompts without asking the image model to invent claims', () => {
  const prompt = buildAssetGenerationPrompt({
    spec: {
      kind: 'HERO', title: '平台商品主图', note: '清楚展示商品本体', size: '1024*1024',
      instruction: '纯净背景正面平铺，柔和光线，完整展示浅粉色圆领短袖T恤。',
    }, productName: '浅粉色圆领短袖T恤', facts, listings: [],
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

test('unified visual planning validates video decisions and original image references',()=>{
 const plan={title:'展示',prompt:'缓慢环绕商品，不改变外观',duration:5,resolution:'720P',sourceFileId:'original',shots:['商品细节']};
 assert.equal(parseUnifiedVideoDecision(JSON.stringify({videoDecision:{required:true,reason:'展示商品细节',plan}}),['original']).plan?.duration,5);
 assert.equal(parseUnifiedVideoDecision(JSON.stringify({videoDecision:{required:false,reason:'用户只需图片',plan:null}}),['original']).plan,null);
 assert.throws(()=>parseUnifiedVideoDecision(JSON.stringify({videoDecision:{required:true,reason:'需要展示',plan:{...plan,sourceFileId:'invented'}}}),['original']));
 assert.throws(()=>parseUnifiedVideoDecision(JSON.stringify({videoDecision:{required:true,reason:'',plan}}),['original']));
});
