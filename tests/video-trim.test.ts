import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVideoTrimRange, isVideoContainer, videoMediaType } from '../lib/domain/video-trim.ts';
import { availableAgentTools, withRegenerationTool } from '../lib/agents/commerce-orchestrator.ts';
import type { AgentWorkflowState } from '../lib/domain/agent-orchestrator.ts';
import { getSelectedMedia } from '../lib/server/media-candidates.ts';

const state: AgentWorkflowState = {taskId:'task_test',intakePresented:true,pendingAttachmentCount:0,taskStatus:'CREATED',productName:'T恤',
 fileCount:1,parsedFileCount:1,imageCount:1,analyzedImageCount:1,factCount:3,openConflictCount:0,draftCount:1,generatedDraftCount:1,
 approvedDraftCount:1,publishedDraftCount:0,generatedAssetCount:4,selectedAssetCount:2,selectedImageCount:1,imagesConfirmed:true,videoJobCount:1,publishApproved:false,
 videoCandidates:[{id:'video_second',title:'穿搭',duration:8,ordinal:2}]};

test('trim bounds reject missing, negative, inverted and out-of-source ranges',()=>{
 assert.deepEqual(validateVideoTrimRange(4,8,8),{start:4,end:8});
 for(const [start,end] of [[-1,4],[4,4],[5,4],[0,9],[NaN,4],[0,Infinity],[0,0.1]]) assert.throws(()=>validateVideoTrimRange(start,end,8));
 assert.throws(()=>validateVideoTrimRange('4',8,8));
});
test('video trim persists real MP4 or WebM container identity, never relabels bytes',()=>{
 assert.ok(isVideoContainer(new Uint8Array([0x1a,0x45,0xdf,0xa3,0]),'video/webm'));
 assert.ok(!isVideoContainer(new Uint8Array([0x1a,0x45,0xdf,0xa3,0]),'video/mp4'));
 assert.ok(!isVideoContainer(new TextEncoder().encode('<html>bad</html>'),'video/webm'));
 assert.equal(videoMediaType({contentType:'video/webm'}),'video/webm');assert.equal(videoMediaType({}),'video/mp4');
});
test('central Agent receives trim tool with parameters only for completed videos before publish',()=>{
 const tool=availableAgentTools(state).find(t=>t.function.name==='trim_product_video');assert.ok(tool);
 assert.ok(tool.function.parameters.properties.videoId);assert.ok(tool.function.parameters.properties.start);
 for(const override of [{videoCandidates:[]},{approvedDraftCount:0},{publishApproved:true},{publishedDraftCount:1}])
  assert.ok(!availableAgentTools({...state,...override}).some(t=>t.function.name==='trim_product_video'));
});
test('regeneration routing must retain video edit tools rather than force full image generation',()=>{
 const tools=availableAgentTools(state);
 for(const content of ['把第二个视频前半段剪掉，第一条不要了','视频换成室内场景，镜头顺序改一下','重新生成视频，不要模特']) {
  const result=withRegenerationTool(tools,[{role:'user',content}],state);
  assert.ok(result.some(t=>t.function.name==='trim_product_video'));
  assert.ok(result.some(t=>t.function.name==='revise_product_video'));
  assert.ok(result.length>1);
 }
});

test('Shopify selected-media boundary preserves trimmed video MIME and requires an image cover',async()=>{
 const DB={prepare:(query:string)=>({bind:()=>({first:async()=>query.includes('video_jobs')
  ?{object_key:'generated/trim.webm',plan_json:JSON.stringify({title:'裁剪版',shots:['保留3–6秒'],contentType:'video/webm'})}
  :{object_key:'generated/cover.png',content_type:'image/png',title:'封面',asset_kind:'HERO',note:'封面'}})})};
 const result=await getSelectedMedia(DB as any,'task_test',['asset_cover','video_trim']);
 assert.equal(result[1].contentType,'video/webm');assert.equal(result[1].type,'VIDEO');
 assert.equal(result[1].objectKey,'generated/trim.webm');
 await assert.rejects(()=>getSelectedMedia(DB as any,'task_test',['video_trim']),/封面/);
});
