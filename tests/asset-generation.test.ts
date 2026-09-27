import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAssetGenerationPrompt, buildAssetPlanningMessages, parseVisualToolDecision, parseAssetPlan, selectConfirmedVideoImages } from '../lib/agents/asset-generation.ts';
import { callBailianAssetPlanning, callBailianImageGeneration, callBailianVisualIntent, checkGeneratedImageAgainstIntent } from '../lib/ai/bailian-client.ts';

test('visual intent Agent retries incomplete output and recognizes a full two-image redo', async () => {
  let calls = 0;
  const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    assert.match(body.messages[1].content, /一张是海报风格，一张是模特图/);
    return Response.json({ choices: [{ message: { content: calls === 1 ? '{}' : '{"scope":"FULL_SET","count":2,"style":"一张海报风格，一张模特图","targetIndices":[]}' } }] });
  }) as typeof fetch;
  const result = await callBailianVisualIntent(
    { apiKey: 'test-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'test-model' },
    { request: '重新帮我生成图片，一张是海报风格，一张是模特图', existingAssets: [{ kind: 'CUSTOM', title: '旧图一', note: '' }, { kind: 'CUSTOM', title: '旧图二', note: '' }] },
    fetchMock,
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, { scope: 'FULL_SET', count: 2, style: '一张海报风格，一张模特图', targetIndices: [] });
});

test('visual intent Agent can identify a single existing image for editing', async () => {
  const fetchMock = (async () => Response.json({ choices: [{ message: { content: '{"scope":"SELECTED","count":null,"style":"海报风格","targetIndices":[2]}' } }] })) as typeof fetch;
  const result = await callBailianVisualIntent(
    { apiKey: 'test-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'test-model' },
    { request: '把第二张改成海报风格', existingAssets: [{ kind: 'CUSTOM', title: '旧图一', note: '' }, { kind: 'CUSTOM', title: '旧图二', note: '' }] },
    fetchMock,
  );
  assert.deepEqual(result.targetIndices, [2]);
});
import { loadBailianImageConfig, missingBailianImageConfig } from '../lib/config/bailian.ts';
import type { ProductFact } from '../lib/domain/product-passport.ts';
import type { GeneratedAsset } from '../lib/domain/generated-asset.ts';

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
    sourceImageCount: 3, userGuidance: '希望增加一张户外通勤穿搭图', requestedCount: 3, styleGuidance: '清新自然',
  });
  assert.match(messages[0].content, /严格生成 3 张/);
  assert.match(messages[0].content, /商家没有要求的模特、主图、细节图等绝不作为必需项补入/);
  assert.match(messages[1].content, /Amazon|amazon/);
  assert.match(messages[1].content, /3 张/);
  assert.match(messages[1].content, /户外通勤穿搭图/);
  assert.match(messages[1].content, /3 张，必须严格遵守/);
  assert.match(messages[1].content, /清新自然/);
});

test('accepts a dynamic image plan without requiring a main image', () => {
  const value = JSON.stringify({ assets: [
    { kind: 'HERO', title: '平台商品主图', note: '清楚展示商品正面', size: '1024*1024', instruction: '纯净背景正面平铺，柔和光线。', acceptance: '商品正面完整可见' },
    { kind: 'MODEL', title: '通勤穿搭图', note: '展示真实穿着效果', size: '1024*1280', instruction: '成年模特在自然通勤场景穿着参考商品。', acceptance: '真人模特穿着商品' },
    { kind: 'DETAIL', title: '面料细节图', note: '突出已确认的棉质纹理', size: '1024*1024', instruction: '微距拍摄面料纹理与领口走线。', acceptance: '面料纹理可见' },
  ] });
  const plan = parseAssetPlan(value);
  assert.deepEqual(plan.map((item) => item.kind), ['HERO', 'MODEL', 'DETAIL']);
  assert.equal(parseAssetPlan(value, 3).length, 3);
  assert.throws(() => parseAssetPlan(value, 2), /按商家要求规划 2 张/);
  const oneImage = JSON.stringify({ assets: [{ kind: 'HERO', title: '商品主图', note: '展示商品', size: '1024*1024', instruction: '完整展示商品。', acceptance: '完整商品可见' }] });
  assert.equal(parseAssetPlan(oneImage, 1).length, 1);
  const withoutHero = parseAssetPlan(JSON.stringify({ assets: [
    { kind: 'MODEL', title: '模特图', note: '展示穿着', size: '1024*1280', instruction: '模特穿着商品。', acceptance: '模特穿着' },
    { kind: 'DETAIL', title: '细节图', note: '展示细节', size: '1024*1024', instruction: '商品细节。', acceptance: '细节可见' },
  ] }));
  assert.deepEqual(withoutHero.map((asset) => asset.kind), ['MODEL', 'DETAIL']);
  assert.equal(parseAssetPlan(oneImage).length, 1);
  const custom = JSON.stringify({ assets: [{ kind: 'CUSTOM', title: '手绘植物主题', note: '无人物的插画风商品图', size: '1024*1024', instruction: '保留原商品颜色和形状，背景使用手绘植物元素，不出现人物。', acceptance: '商品清楚可见，周围有手绘植物，不出现人物' }] });
  assert.equal(parseAssetPlan(custom, 1)[0].kind, 'CUSTOM');
});

test('calls the text model to plan assets in JSON mode', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({
      id: 'plan_req_1', model: 'qwen3.8-max',
      choices: [{ message: { content: JSON.stringify({ assets: [
        { kind: 'HERO', title: '商品主图', note: '平台首图', size: '1024*1024', instruction: '正面商品主图。', acceptance: '商品正面可见' },
        { kind: 'LIFESTYLE', title: '通勤场景', note: '展示使用氛围', size: '1024*1280', instruction: '户外通勤场景。', acceptance: '户外通勤场景可见' },
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
      instruction: '纯净背景正面平铺，柔和光线，完整展示浅粉色圆领短袖T恤。', acceptance: '完整展示商品。',
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
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg', prompt: '生成商品主图', size: '1024*1024', negativePrompt: '模特、人物',
  }, fetchMock);
  assert.equal(calls[0].url, 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  const body = JSON.parse(String(calls[0].init?.body)) as { model: string; input: { messages: Array<{ content: Array<{ image?: string }> }> }; parameters: { watermark: boolean; prompt_extend: boolean; negative_prompt: string } };
  assert.equal(body.model, 'qwen-image-2.0');
  assert.match(body.input.messages[0].content[0].image ?? '', /^data:image\/jpeg;base64,/);
  assert.equal(body.parameters.watermark, false);
  assert.equal(body.parameters.prompt_extend, false);
  assert.match(body.parameters.negative_prompt, /模特、人物/);
  assert.deepEqual([...result.bytes], [137, 80, 78, 71]);
  assert.equal(result.width, 1024);
});

test('image planning never asks the model to submit a video before image approval',()=>{
 const messages=buildAssetPlanningMessages({productName:'T恤',facts,listings:[],platforms:['amazon'],markets:['US'],sourceImageCount:1,sourceImageIds:['original']});
 assert.match(messages[0].content,/只规划图片，不规划、提交或生成视频/);
 assert.doesNotMatch(messages[0].content,/videoDecision/);
});

test('plans a specified image revision without replacing the whole image set', () => {
  assert.deepEqual(parseVisualToolDecision('{"scope":"SELECTED","targetIndices":[3]}', 3).targetIndices, [3]);
  const context = {
    productName: '浅粉色圆领短袖T恤', facts, listings: [], platforms: ['amazon' as const], markets: ['美国'],
    sourceImageCount: 1, existingAssets: [
      { kind: 'HERO' as const, title: '主图', note: '白底' },
      { kind: 'LIFESTYLE' as const, title: '场景', note: '咖啡馆' },
      { kind: 'MODEL' as const, title: '模特图', note: '户外穿搭' },
    ], targetIndices: [3], userGuidance: '把第三张图生成海报样式',
  };
  const messages = buildAssetPlanningMessages(context);
  assert.match(messages[0].content, /只输出 1 个 assets/);
  assert.match(messages[1].content, /第 3 张/);
  assert.match(messages[1].content, /咖啡馆/);
  const poster = JSON.stringify({ assets: [{ kind: 'POSTER', title: '穿搭海报', note: '海报视觉', size: '1024*1280', instruction: '以原商品为主体，海报式构图。', acceptance: '明显海报式构图' }] });
  assert.equal(parseAssetPlan(poster, null, [3])[0].kind, 'POSTER');
  assert.equal(parseAssetPlan(poster, null, [1])[0].kind, 'POSTER');
  assert.equal(parseAssetPlan(poster).length, 1);
  const prompt = buildAssetGenerationPrompt({ spec: parseAssetPlan(poster, null, [3])[0], productName: context.productName, facts, listings: [], previousAsset: context.existingAssets[2] });
  assert.match(prompt, /输入图片是本轮要修改的旧图/);
  assert.match(prompt, /海报式构图/);
});

test('visual tool decisions are model supplied and structurally validated without reading request wording', () => {
  assert.deepEqual(parseVisualToolDecision('{"scope":"FULL_SET","count":2,"style":"海报和模特"}', 3), { scope: 'FULL_SET', count: 2, style: '海报和模特', targetIndices: [] });
  assert.deepEqual(parseVisualToolDecision('{"scope":"SELECTED","targetIndices":[3,1]}', 3).targetIndices, [1, 3]);
  assert.throws(() => parseVisualToolDecision('{}', 3), /未明确图片操作范围/);
  assert.throws(() => parseVisualToolDecision('{"scope":"SELECTED","targetIndices":[]}', 3), /图片序号无效/);
  assert.throws(() => parseVisualToolDecision('{"scope":"SELECTED","targetIndices":[4]}', 3), /图片序号无效/);
  assert.throws(() => parseVisualToolDecision('{"scope":"FULL_SET","targetIndices":[3]}', 3), /不能指定局部/);
});

test('semantic plan review rejects a missed seller requirement without fixed image-kind rules', async () => {
  const guidance = '重新帮我生成图片，一张是海报风格，一张是模特图';
  const context = { productName: '浅粉色圆领短袖T恤', facts, listings: [], platforms: ['amazon' as const], markets: ['美国'], sourceImageCount: 1, userGuidance: guidance };
  const messages = buildAssetPlanningMessages(context);
  assert.match(messages[0].content, /不指定主图/);
  const wrong = JSON.stringify({ assets: [
    { kind: 'POSTER', title: '穿搭海报', note: '海报视觉', size: '1024*1280', instruction: '海报式构图。', acceptance: '有海报式设计' },
    { kind: 'HERO', title: '白底主图', note: '商品主图', size: '1024*1024', instruction: '白底商品图。', acceptance: '白底商品照' },
  ] });
  const correct = JSON.stringify({ assets: [
    { kind: 'POSTER', title: '穿搭海报', note: '海报视觉', size: '1024*1280', instruction: '海报式构图。', acceptance: '明显海报式构图' },
    { kind: 'MODEL', title: '模特展示', note: '真人穿着', size: '1024*1280', instruction: '真人模特穿着参考商品。', acceptance: '真人模特穿着这件T恤' },
  ] });
  assert.equal(parseAssetPlan(wrong).length, 2);
  let calls = 0;
  const responses = [wrong, '{"satisfies":false,"reason":"缺少模特穿着图"}', correct, '{"satisfies":true,"reason":"满足"}'];
  const fetchMock: typeof fetch = async () => Response.json({ choices: [{ message: { content: responses[calls++] } }] });
  const result = await callBailianAssetPlanning({ apiKey: 'test-key', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'test-model' }, context, fetchMock);
  assert.equal(calls, 4);
  assert.deepEqual(result.assets.map((asset) => asset.kind), ['POSTER', 'MODEL']);
  const modelPrompt = buildAssetGenerationPrompt({ spec: result.assets[1], productName: context.productName, facts, listings: [] });
  assert.match(modelPrompt, /真人模特穿着这件T恤/);
});

test('the latest seller request overrides exclusions inherited from older image briefs', async () => {
  const guidance = '重新生成两张图片，一张海报风格，一张真人模特穿着展示';
  const context = { productName: '浅粉色圆领短袖T恤', facts, listings: [], platforms: ['amazon' as const], markets: ['美国'], sourceImageCount: 1, userGuidance: guidance,
    existingAssets: [{ kind: 'CUSTOM' as const, title: '旧图', note: '上一轮不含人物的场景图' }] };
  const plan = JSON.stringify({ assets: [
    { kind: 'POSTER', title: '海报', note: '海报风格', size: '1024*1280', instruction: '商品海报设计。', acceptance: '海报式构图' },
    { kind: 'MODEL', title: '穿着展示', note: '真人模特', size: '1024*1280', instruction: '真人模特穿着商品。', acceptance: '真人模特穿着商品' },
  ] });
  const sent: string[] = [];
  const fetchMock: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    sent.push(JSON.stringify(body.messages));
    return Response.json({ choices: [{ message: { content: sent.length === 1 ? plan : '{"satisfies":true,"reason":"符合本轮要求"}' } }] });
  };
  await callBailianAssetPlanning({ apiKey: 'test-key', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'test-model' }, context, fetchMock);
  assert.match(sent[0], /本轮明确提出的要求覆盖旧图/);
  assert.match(sent[1], /不可把旧图或以前的偏好当成本轮限制/);
  const posterPrompt = buildAssetGenerationPrompt({ spec: parseAssetPlan(plan)[0], productName: context.productName, facts, listings: [] });
  assert.match(posterPrompt, /本张图片的视觉类型：POSTER/);
  assert.doesNotMatch(posterPrompt, /一张真人模特穿着展示/);
  const modelPrompt = buildAssetGenerationPrompt({ spec: parseAssetPlan(plan)[1], productName: context.productName, facts, listings: [] });
  assert.match(modelPrompt, /本张图片的视觉类型：MODEL/);
  assert.doesNotMatch(modelPrompt, /一张海报风格/);
});

test('checks any generated image against its own visual acceptance criteria', async () => {
  const fetchMock: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    assert.match(body.messages[0].content.find((part) => part.type === 'text')?.text ?? '', /画面有手绘植物边框/);
    return Response.json({ choices: [{ message: { content: '{"matches":false,"reason":"没有植物边框"}' } }] });
  };
  const result = await checkGeneratedImageAgainstIntent({ apiKey: 'test-key', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max' }, { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png', instruction: '为商品做植物主题图片', acceptance: '画面有手绘植物边框' }, fetchMock);
  assert.deepEqual(result, { matches: false, reason: '没有植物边框' });
});

test('image review sees the latest request and original product image', async () => {
  const fetchMock: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    assert.equal(body.messages[0].content.filter((part) => part.type === 'image_url').length, 2);
    assert.match(body.messages[0].content.find((part) => part.type === 'text')?.text ?? '', /一张海报，一张模特图/);
    return Response.json({ choices: [{ message: { content: '{"matches":true,"reason":"符合本轮要求"}' } }] });
  };
  const result = await checkGeneratedImageAgainstIntent({ apiKey: 'test-key', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max' }, {
    bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png', instruction: '模特穿着商品', acceptance: '真人模特穿着商品', userGuidance: '一张海报，一张模特图', imageRole: 'MODEL｜穿着展示', otherRoles: ['POSTER｜商品海报'],
    reference: { bytes: new Uint8Array([4, 5, 6]), contentType: 'image/png' },
  }, fetchMock);
  assert.equal(result.matches, true);
});

test('video accepts only confirmed images from the latest generated batch',()=>{
 const image=(id:string,status:'COMPLETED'|'FAILED'='COMPLETED'):GeneratedAsset=>({id,taskId:'task_demo',sourceFileId:'file_original',batchId:'latest',kind:'HERO',title:'主图',note:'正面',model:'image',status,width:1024,height:1024,error:null,createdAt:'',completedAt:null,imageUrl:'/image'});
 const latest=[image('asset_cover'),image('asset_scene'),image('asset_failed','FAILED'),{...image('asset_rejected'),error:'画面出现模特，违背用户要求'}];
 assert.deepEqual(selectConfirmedVideoImages(latest,['asset_scene','asset_cover']).map(v=>v.id),['asset_scene','asset_cover']);
 assert.throws(()=>selectConfirmedVideoImages(latest,['asset_old']),/当前可用素材/);
 assert.throws(()=>selectConfirmedVideoImages(latest,['asset_failed']),/当前可用素材/);
 assert.throws(()=>selectConfirmedVideoImages(latest,['asset_rejected']),/当前可用素材/);
 assert.throws(()=>selectConfirmedVideoImages(latest,['asset_cover','asset_cover']),/不能重复/);
 assert.throws(()=>selectConfirmedVideoImages(latest,[]),/先确认最终图片/);
});
