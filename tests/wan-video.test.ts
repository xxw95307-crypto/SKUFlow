import test from 'node:test';
import assert from 'node:assert/strict';
import {loadWanVideoConfig,requireWanConfig,parseVideoPlan,submitWanVideo,queryWanVideo} from '../lib/ai/wan-video.ts';
const c={apiKey:'test-secret',baseUrl:'https://dashscope.aliyuncs.com/api/v1',model:'wan2.7-i2v'};
const plan={title:'商品展示',prompt:'保持商品结构一致，缓慢推进镜头',duration:5,resolution:'720P' as const,sourceFileId:'asset_cover',shots:['商品全貌','细节']};
test('video configuration reuses authorized Bailian key but always uses native video endpoint',()=>{
 assert.equal(loadWanVideoConfig({}).apiKey,'');assert.equal(loadWanVideoConfig({BAILIAN_API_KEY:'shared'}).apiKey,'shared');assert.equal(loadWanVideoConfig({BAILIAN_API_KEY:'shared'}).baseUrl,'https://dashscope.aliyuncs.com/api/v1');assert.throws(()=>requireWanConfig(loadWanVideoConfig({})),/配置/);
 assert.throws(()=>requireWanConfig({...c,baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'}),/compatible-mode/);
});
test('plan must reference a selected source image and supported duration',()=>{
 assert.equal(parseVideoPlan(plan,['asset_cover']).sourceFileId,'asset_cover');assert.throws(()=>parseVideoPlan(plan,['other']));assert.throws(()=>parseVideoPlan({...plan,duration:30},['asset_cover']));
});
test('submit uses async native video API and returns provider ID rather than claiming completion',async()=>{
 let body:any;const id=await submitWanVideo(c,plan,'data:image/png;base64,AAA',async(url,init)=>{
 assert.match(String(url),/video-synthesis$/);assert.equal((init?.headers as any)['X-DashScope-Async'],'enable');body=JSON.parse(String(init?.body));return Response.json({output:{task_id:'provider-1',task_status:'PENDING'}});
 });assert.equal(id,'provider-1');assert.equal(body.model,'wan2.7-i2v');assert.equal(body.input.media[0].type,'first_frame');assert.equal(body.parameters.prompt_extend,false);assert.equal(body.parameters.watermark,true);
});
test('polling uses existing task ID; failed task stays failed and invalid download host is rejected',async()=>{
 const failed=await queryWanVideo(c,'provider-1',async(url,init)=>{assert.match(String(url),/tasks\/provider-1$/);assert.equal(init?.method,'GET');return Response.json({output:{task_status:'FAILED',message:'quota'}});});assert.equal(failed.task_status,'FAILED');
 await assert.rejects(()=>queryWanVideo(c,'p',async()=>Response.json({output:{task_status:'SUCCEEDED',video_url:'https://example.com/movie.mp4'}})),/地址无效/);
});
