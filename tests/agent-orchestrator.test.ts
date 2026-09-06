import assert from 'node:assert/strict';
import test from 'node:test';
import { availableAgentTools, soleRequiredAgentTool } from '../lib/agents/commerce-orchestrator.ts';
import { callBailianOrchestrator } from '../lib/ai/bailian-client.ts';
import type { AgentWorkflowState } from '../lib/domain/agent-orchestrator.ts';

function state(overrides: Partial<AgentWorkflowState> = {}): AgentWorkflowState {
  return {
    taskId: 'task_demo', intakePresented: true, pendingAttachmentCount: 0, taskStatus: 'CREATED', productName: null,
    fileCount: 2, parsedFileCount: 0, imageCount: 1, analyzedImageCount: 0,
    factCount: 0, openConflictCount: 0, draftCount: 2, generatedDraftCount: 0,
    approvedDraftCount: 0, publishedDraftCount: 0, generatedAssetCount: 0, selectedAssetCount: 0,
    publishApproved: false,
    ...overrides,
  };
}

test('orchestrator exposes only tools valid for the trusted workflow state', () => {
  assert.deepEqual(availableAgentTools(state()).map((item) => item.function.name), ['parse_product_sources']);
  assert.deepEqual(availableAgentTools(state({ parsedFileCount: 2 })).map((item) => item.function.name), ['analyze_product_images']);
  assert.deepEqual(availableAgentTools(state({ parsedFileCount: 2, analyzedImageCount: 1 })).map((item) => item.function.name), ['merge_product_facts']);
  assert.deepEqual(availableAgentTools(state({ parsedFileCount: 2, analyzedImageCount: 1, factCount: 8, openConflictCount: 1 })).map((item) => item.function.name), ['open_conflict_review']);
});

test('a blank conversation only exposes the tool that opens the listing intake', () => {
  const blank = state({ taskId: null, intakePresented: false, fileCount: 0, draftCount: 0 });
  assert.deepEqual(availableAgentTools(blank).map((item) => item.function.name), ['start_listing_workflow']);
  assert.deepEqual(availableAgentTools({ ...blank, intakePresented: true }), []);
});

test('chat attachments expose inspection and task creation as separate Agent decisions', () => {
  const attached = state({ taskId: null, intakePresented: false, pendingAttachmentCount: 2, fileCount: 0, draftCount: 0 });
  assert.deepEqual(availableAgentTools(attached).map((item) => item.function.name), [
    'inspect_chat_attachments',
    'create_listing_task_from_attachments',
    'start_listing_workflow',
  ]);
});

test('Agent generates assets before selection and requires explicit approval before publishing', () => {
  const approved = state({ parsedFileCount: 2, analyzedImageCount: 1, factCount: 8, generatedDraftCount: 2, approvedDraftCount: 2 });
  assert.deepEqual(availableAgentTools(approved).map((item) => item.function.name), ['generate_visual_assets']);
  assert.deepEqual(availableAgentTools({ ...approved, generatedAssetCount: 3 }).map((item) => item.function.name), ['open_asset_selection']);
  assert.deepEqual(availableAgentTools({ ...approved, generatedAssetCount: 3, selectedAssetCount: 2 }).map((item) => item.function.name), ['open_publish_confirmation']);
  assert.deepEqual(availableAgentTools({ ...approved, generatedAssetCount: 3, selectedAssetCount: 2, publishApproved: true }).map((item) => item.function.name), ['publish_mock_drafts']);
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
