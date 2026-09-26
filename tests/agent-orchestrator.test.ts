import assert from 'node:assert/strict';
import test from 'node:test';
import { availableAgentTools, restrictIntakeToolsForListingRequest, soleRequiredAgentTool, withBacktrackTools } from '../lib/agents/commerce-orchestrator.ts';
import { callBailianOrchestrator } from '../lib/ai/bailian-client.ts';
import type { AgentWorkflowState } from '../lib/domain/agent-orchestrator.ts';

function state(overrides: Partial<AgentWorkflowState> = {}): AgentWorkflowState {
  return {
    taskId: 'task_demo', intakePresented: true, pendingAttachmentCount: 0, taskStatus: 'CREATED', productName: null,
    fileCount: 2, parsedFileCount: 0, imageCount: 1, analyzedImageCount: 0,
    factCount: 0, openConflictCount: 0, resolvedConflictCount: 0, draftCount: 2, generatedDraftCount: 0,
    approvedDraftCount: 0, publishedDraftCount: 0, generatedAssetCount: 0, selectedAssetCount: 0,
    publishApproved: false,
    ...overrides,
  };
}

test('orchestrator exposes only tools valid for the trusted workflow state', () => {
  assert.deepEqual(availableAgentTools(state()).map((item) => item.function.name), ['parse_product_sources']);
  assert.deepEqual(availableAgentTools(state({ parsedFileCount: 2 })).map((item) => item.function.name), ['analyze_product_images']);
  assert.deepEqual(availableAgentTools(state({ parsedFileCount: 2, analyzedImageCount: 1 })).map((item) => item.function.name), ['merge_product_facts']);
  assert.deepEqual(availableAgentTools(state({ parsedFileCount: 2, analyzedImageCount: 1, factCount: 8, openConflictCount: 1 })).map((item) => item.function.name), ['merge_product_facts', 'open_conflict_review']);
});

test('a blank conversation only exposes the tool that opens the listing intake', () => {
  const blank = state({ taskId: null, intakePresented: false, fileCount: 0, draftCount: 0 });
  assert.deepEqual(availableAgentTools(blank).map((item) => item.function.name), ['start_listing_workflow']);
  assert.deepEqual(availableAgentTools({ ...blank, intakePresented: true }).map((item) => item.function.name), ['start_listing_workflow']);
});

test('chat attachments expose inspection and task creation as separate Agent decisions', () => {
  const attached = state({ taskId: null, intakePresented: false, pendingAttachmentCount: 2, fileCount: 0, draftCount: 0 });
  assert.deepEqual(availableAgentTools(attached).map((item) => item.function.name), [
    'inspect_chat_attachments',
    'create_listing_task_from_attachments',
    'start_listing_workflow',
  ]);
});

test('listing requests without explicit platform and market can only open seller selection', () => {
  const attached = state({ taskId: null, intakePresented: false, pendingAttachmentCount: 2, fileCount: 0, draftCount: 0 });
  const tools = restrictIntakeToolsForListingRequest(availableAgentTools(attached), attached, '帮我上新这款产品');
  assert.deepEqual(tools.map((item) => item.function.name), ['start_listing_workflow']);
});

test('listing requests with explicit platform and market can create from attachments directly', () => {
  const attached = state({ taskId: null, intakePresented: false, pendingAttachmentCount: 2, fileCount: 0, draftCount: 0 });
  const tools = restrictIntakeToolsForListingRequest(availableAgentTools(attached), attached, '帮我上新到亚马逊美国站');
  assert.deepEqual(tools.map((item) => item.function.name), ['create_listing_task_from_attachments']);
});

test('Agent confirms images before video and requires video-stage completion before publishing', () => {
  const approved = state({ parsedFileCount: 2, analyzedImageCount: 1, factCount: 8, generatedDraftCount: 2, approvedDraftCount: 2 });
  assert.deepEqual(availableAgentTools(approved).map((item) => item.function.name), ['merge_product_facts']);
  assert.deepEqual(availableAgentTools({ ...approved, imageBriefConfirmed: true }).map((item) => item.function.name), ['merge_product_facts', 'generate_visual_assets']);
  assert.deepEqual(availableAgentTools({ ...approved, generatedAssetCount: 3 }).map((item) => item.function.name), ['merge_product_facts', 'generate_visual_assets', 'open_asset_selection']);
  const selected = { ...approved, generatedAssetCount: 3, selectedAssetCount: 2, selectedImageCount: 2, imagesConfirmed: true };
  assert.ok(!availableAgentTools({ ...selected, imagesConfirmed: false }).some((item) => item.function.name === 'generate_product_video'));
  assert.deepEqual(availableAgentTools(selected).map((item) => item.function.name), ['merge_product_facts', 'generate_visual_assets', 'generate_product_video']);
  assert.deepEqual(availableAgentTools({ ...selected, videoJobCount: 1 }).map((item) => item.function.name), ['merge_product_facts', 'generate_visual_assets', 'revise_product_video']);
  assert.deepEqual(availableAgentTools({ ...selected, videoJobCount: 1, videoStageComplete: true }).map((item) => item.function.name), ['merge_product_facts', 'generate_visual_assets', 'revise_product_video', 'open_publish_confirmation']);
  assert.deepEqual(availableAgentTools({ ...selected, videoStageComplete: true, publishApproved: true }).map((item) => item.function.name), ['merge_product_facts', 'publish_mock_drafts']);
});

test('trusted workflow may safely recover only when exactly one tool is required', () => {
  const oneTool = availableAgentTools(state());
  assert.equal(soleRequiredAgentTool(oneTool, true)?.function.name, 'parse_product_sources');
  assert.equal(soleRequiredAgentTool(oneTool, false), null);
  const severalTools = availableAgentTools(state({ taskId: null, intakePresented: false, pendingAttachmentCount: 2, fileCount: 0, draftCount: 0 }));
  assert.equal(soleRequiredAgentTool(severalTools, true), null);
});

test('Bailian orchestrator sends standard function tools and parses one tool call', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const fetchMock: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: 'req_1', model: 'qwen3.8-max',
      choices: [{ message: { content: '先读取资料。', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'parse_product_sources', arguments: '{}' } }] } }],
      usage: { total_tokens: 123 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tools = availableAgentTools(state());
  const result = await callBailianOrchestrator({ apiKey: 'test-key', baseUrl: 'https://example.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max' }, {
    systemPrompt: 'system', messages: [{ role: 'user', content: '继续' }], tools, requireTool: true,
  }, fetchMock);
  assert.equal(result.message.toolCalls[0]?.function.name, 'parse_product_sources');
  assert.equal(result.message.content, '先读取资料。');
  assert.deepEqual(requestBody?.tool_choice, { type: 'function', function: { name: 'parse_product_sources' } });
  assert.equal(requestBody?.parallel_tool_calls, false);
});

test('Bailian 403 exposes the provider reason and does not retry a permission error', async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 'access_denied', message: 'Access denied to this model.' } }), {
      status: 403,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-403' },
    });
  };
  await assert.rejects(
    callBailianOrchestrator({ apiKey: 'sk-general-test-key', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max' }, {
      systemPrompt: 'system', messages: [{ role: 'user', content: '继续' }], tools: availableAgentTools(state()), requireTool: true,
    }, fetchMock),
    /HTTP 403.*request-403.*access_denied.*Token Plan 地址.*专属 Key/,
  );
  assert.equal(calls, 1);
});

test('central Agent retains regeneration after image selection, but never after publication authorization',()=>{
 const ready=state({parsedFileCount:2,analyzedImageCount:1,factCount:8,generatedDraftCount:2,approvedDraftCount:2,generatedAssetCount:3});
 assert.ok(availableAgentTools(ready).some(t=>t.function.name==='generate_visual_assets'));
 assert.ok(availableAgentTools({...ready,selectedAssetCount:2}).some(t=>t.function.name==='generate_visual_assets'));
 assert.ok(!availableAgentTools({...ready,selectedAssetCount:2,publishApproved:true}).some(t=>t.function.name==='generate_visual_assets'));
 assert.ok(!availableAgentTools({...ready,publishedDraftCount:2}).some(t=>t.function.name==='generate_visual_assets'));
});

test('backtrack tools are injected only when the user expresses the matching intent', () => {
  const conflicted = state({ parsedFileCount: 2, analyzedImageCount: 1, factCount: 8, openConflictCount: 1, resolvedConflictCount: 2 });
  const messages = (text: string) => [{ role: 'user' as const, content: text }];
  // 无回退意图时不注入
  assert.deepEqual(withBacktrackTools(availableAgentTools(conflicted), messages('型号的真实值是哪一个？X-200 还是 X-300？'), conflicted).map((t) => t.function.name).filter((n) => n.startsWith('re') || n === 'update_task_targets'), []);
  // 改目标意图注入 update_task_targets
  const targets = withBacktrackTools(availableAgentTools(conflicted), messages('我想重新进行站点以及平台的选择，改成只上 Amazon 和 TikTok Shop'), conflicted);
  assert.ok(targets.some((t) => t.function.name === 'update_task_targets'));
  // 重新解析意图注入 reparse_sources
  const reparse = withBacktrackTools(availableAgentTools(conflicted), messages('说明文档内容更新了，帮我重新解析一下资料'), conflicted);
  assert.ok(reparse.some((t) => t.function.name === 'reparse_sources'));
  // 重新看图意图注入 reanalyze_images
  const reanalyze = withBacktrackTools(availableAgentTools(conflicted), messages('图片属性识别错了，重新看一遍图'), conflicted);
  assert.ok(reanalyze.some((t) => t.function.name === 'reanalyze_images'));
  // 重新裁决冲突意图注入 reopen_resolved_conflicts
  const reopen = withBacktrackTools(availableAgentTools(conflicted), messages('我想重新裁决之前的冲突'), conflicted);
  assert.ok(reopen.some((t) => t.function.name === 'reopen_resolved_conflicts'));
  // 没有已裁决冲突时不注入 reopen
  const noResolved = state({ parsedFileCount: 2, analyzedImageCount: 1, factCount: 8, openConflictCount: 1, resolvedConflictCount: 0 });
  assert.ok(!withBacktrackTools(availableAgentTools(noResolved), messages('我想重新裁决之前的冲突'), noResolved).some((t) => t.function.name === 'reopen_resolved_conflicts'));
  // 已发布后一律不可回退
  const published = state({ ...conflicted, publishedDraftCount: 2 });
  const publishedTools = availableAgentTools(published);
  assert.deepEqual(withBacktrackTools(publishedTools, messages('我想重新选站点和平台'), published).map((t) => t.function.name), publishedTools.map((t) => t.function.name));
});

test('video revision is available only after an image-backed video job exists',()=>{
 const ready=state({parsedFileCount:2,analyzedImageCount:1,factCount:8,generatedDraftCount:2,approvedDraftCount:2,generatedAssetCount:3,selectedAssetCount:2,selectedImageCount:2,imagesConfirmed:true,videoJobCount:1});
 const has=(s:AgentWorkflowState)=>availableAgentTools(s).some(t=>t.function.name==='revise_product_video');
 assert.ok(has(ready));assert.ok(has({...ready,selectedAssetCount:2}));
 assert.ok(!has({...ready,videoJobCount:0}));
 assert.ok(!has({...ready,approvedDraftCount:0}));assert.ok(!has({...ready,publishApproved:true}));assert.ok(!has({...ready,publishedDraftCount:2}));
});
