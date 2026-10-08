import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScenePlanningMessages, parseScenePlanningOutput } from '../lib/agents/scene-planning.ts';
import { parseAssetPlan } from '../lib/agents/asset-generation.ts';
import { parseScenePlan } from '../lib/domain/scene-plan.ts';
import { mediaIdsForScene } from '../lib/agents/scene-media.ts';
import { availableAgentTools, requiredListingStageTool } from '../lib/agents/commerce-orchestrator.ts';
import type { AgentWorkflowState } from '../lib/domain/agent-orchestrator.ts';

const scenes = parseScenePlanningOutput(JSON.stringify({ scenes: [
  { name: '通勤', visualBrief: '办公室自然光下展示实物', copyBrief: '突出日常通勤搭配' },
  { name: '周末', visualBrief: '周末咖啡馆展示实物', copyBrief: '突出休闲穿搭氛围' },
] }), 2);

test('scene planning keeps the same product facts while returning distinct directions', () => {
  assert.deepEqual(scenes.map((scene) => scene.id), ['scene_1', 'scene_2']);
  const messages = buildScenePlanningMessages({ productName: '针织衫', facts: [], count: 2, directions: ['通勤', '周末'] });
  assert.match(messages[0].content, /同一件真实商品/);
  assert.match(messages[1].content, /通勤/);
  assert.throws(() => parseScenePlanningOutput(JSON.stringify({ scenes: [
    { name: '通勤', visualBrief: '办公室', copyBrief: '通勤' },
    { name: '通勤', visualBrief: '咖啡馆', copyBrief: '休闲' },
  ] }), 2), /重复/);
});

test('listing generation pauses for a scene decision before creating drafts', () => {
  const state: AgentWorkflowState = {
    taskId: 'task_1', intakePresented: true, pendingAttachmentCount: 0, taskStatus: 'FACTS_EXTRACTED', productName: '针织衫',
    fileCount: 2, parsedFileCount: 2, imageCount: 1, analyzedImageCount: 1, factCount: 5,
    openConflictCount: 0, resolvedConflictCount: 0, scenePlanConfirmed: false, sceneCount: 1,
    draftCount: 2, generatedDraftCount: 0, approvedDraftCount: 0, publishedDraftCount: 0,
    generatedAssetCount: 0, selectedAssetCount: 0, publishApproved: false,
  };
  assert.equal(requiredListingStageTool(state), 'open_scene_plan');
  assert.equal(requiredListingStageTool({ ...state, scenePlanConfirmed: true, sceneCount: 2, draftCount: 4 }), 'generate_platform_listings');
});

const asset = (sceneId: string, title: string) => ({ sceneId, kind: 'LIFESTYLE', title, note: `${title}展示`, size: '1024*1024', instruction: `${title}场景展示真实商品`, acceptance: `画面呈现${title}`, sourceMode: 'ORIGINAL' });

test('each split scene receives its chosen image count, and delivery keeps images separated', () => {
  const countedScenes = [{ ...scenes[0], imageCount: 2 }, { ...scenes[1], imageCount: 3 }];
  assert.deepEqual(parseScenePlan(JSON.stringify({ mode: 'SPLIT', scenes: countedScenes, confirmedAt: '2026-10-08T00:00:00.000Z' }))?.scenes.map((scene) => scene.imageCount), [2, 3]);
  const planned = parseAssetPlan(JSON.stringify({ assets: [asset('scene_1', '通勤全身'), asset('scene_1', '通勤细节'), asset('scene_2', '周末咖啡馆'), asset('scene_2', '周末街拍'), asset('scene_2', '周末特写')] }), 5, undefined, countedScenes);
  assert.deepEqual(planned.map((item) => item.sceneId), ['scene_1', 'scene_1', 'scene_2', 'scene_2', 'scene_2']);
  assert.throws(() => parseAssetPlan(JSON.stringify({ assets: [asset('scene_1', '通勤'), asset('scene_1', '通勤二'), asset('scene_1', '通勤三'), asset('scene_2', '周末'), asset('scene_2', '周末二')] }), 5, undefined, countedScenes), /每套场景/);
  const candidates = [
    { id: 'image_1', sceneId: 'scene_1', type: 'IMAGE' as const },
    { id: 'image_2', sceneId: 'scene_2', type: 'IMAGE' as const },
    { id: 'video', sceneId: 'base', type: 'VIDEO' as const },
  ];
  assert.deepEqual(mediaIdsForScene(['image_1', 'video', 'image_2'], candidates, 'scene_2', true), ['image_2']);
  assert.throws(() => mediaIdsForScene(['image_1'], candidates, 'scene_2', true), /缺少/);
});

test('a partly delivered scene batch can still deliver its remaining draft', () => {
  const state: AgentWorkflowState = {
    taskId: 'task_1', intakePresented: true, pendingAttachmentCount: 0, taskStatus: 'READY', productName: '针织衫',
    fileCount: 2, parsedFileCount: 2, imageCount: 1, analyzedImageCount: 1, factCount: 5,
    openConflictCount: 0, resolvedConflictCount: 0, scenePlanConfirmed: true, sceneCount: 2,
    draftCount: 2, generatedDraftCount: 2, approvedDraftCount: 2, publishedDraftCount: 1,
    generatedAssetCount: 2, selectedAssetCount: 2, selectedImageCount: 2, imagesConfirmed: true,
    videoStageComplete: true, publishApproved: true,
  };
  assert.ok(availableAgentTools(state).some((item) => item.function.name === 'publish_mock_drafts'));
});
