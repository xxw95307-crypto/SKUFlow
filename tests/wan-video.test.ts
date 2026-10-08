import test from 'node:test';
import assert from 'node:assert/strict';
import {loadWanVideoConfig,requireWanConfig,parseVideoPlan,createCustomVideoPlan,submitWanVideo,queryWanVideo,synthesizeNarration,synthesizeVideoSound,wavDurationSeconds,matchedVideoDuration,WanVideoRequestError} from '../lib/ai/wan-video.ts';
import {isReusableVideoJob} from '../lib/domain/video-job-retry.ts';
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
 },'https://example.aliyuncs.com/sound.wav');assert.equal(id,'provider-1');assert.equal(body.model,'wan2.7-i2v');assert.equal(body.input.media[0].type,'first_frame');assert.equal(body.parameters.prompt_extend,false);assert.equal(body.parameters.watermark,true);
});
test('polling uses existing task ID; failed task stays failed and invalid download host is rejected',async()=>{
 const failed=await queryWanVideo(c,'provider-1',async(url,init)=>{assert.match(String(url),/tasks\/provider-1$/);assert.equal(init?.method,'GET');return Response.json({output:{task_status:'FAILED',message:'quota'}});});assert.equal(failed.task_status,'FAILED');
 await assert.rejects(()=>queryWanVideo(c,'p',async()=>Response.json({output:{task_status:'SUCCEEDED',video_url:'https://example.com/movie.mp4'}})),/地址无效/);
});
test('every sound mode carries real audio into the video request',async()=>{
 const requests:any[]=[];
 const fetcher=async(_url:RequestInfo|URL,init?:RequestInit)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({output:{task_id:'provider-2',task_status:'PENDING'}});};
 await submitWanVideo(c,{...plan,audioMode:'music'},'data:image/png;base64,AAA',fetcher as typeof fetch,'https://example.aliyuncs.com/music.wav');
 assert.match(requests[0].input.prompt,/纯音乐/);assert.equal(requests[0].input.media[1].type,'driving_audio');
 await submitWanVideo(c,{...plan,audioMode:'narration',narrationText:'柔软透气，轻松出行。'},'data:image/png;base64,AAA',fetcher as typeof fetch,'https://example.aliyuncs.com/voice.mp3');
 assert.equal(requests[1].input.media[1].type,'driving_audio');assert.match(requests[1].input.prompt,/画外解说/);
 await assert.rejects(()=>submitWanVideo(c,{...plan,audioMode:'narration',narrationText:'解说'},'data:image/png;base64,AAA',fetcher as typeof fetch),/生成配音/);
 await assert.rejects(()=>submitWanVideo(c,{...plan,audioMode:'ambient'},'data:image/png;base64,AAA',fetcher as typeof fetch),/先生成自然音效/);
});
function sampleWav(seconds:number){
 const dataSize=seconds*24000*2,buffer=Buffer.alloc(44+dataSize);
 buffer.write('RIFF',0);buffer.writeUInt32LE(36+dataSize,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(24000,24);buffer.writeUInt32LE(48000,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(dataSize,40);
 buffer.fill(0x20,44);
 return buffer;
}
test('narration synthesis measures its real WAV length before video submission',async()=>{
 let body:any;
 const url=await synthesizeNarration(c,'这是一件浅粉色圆领短袖。',async(endpoint,init)=>{
  if(String(endpoint).includes('/voice.wav'))return new Response(sampleWav(4.5));
  assert.match(String(endpoint),/SpeechSynthesizer$/);body=JSON.parse(String(init?.body));
  return Response.json({output:{audio:{url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/voice.wav?signature=demo'}}});
 });
 assert.equal(body.input.text,'这是一件浅粉色圆领短袖。');assert.equal(body.input.format,'wav');assert.match(url.url,/voice\.wav/);assert.equal(url.duration,4.5);assert.equal(matchedVideoDuration(url.duration),5);
 await assert.rejects(()=>synthesizeNarration(c,'解说',async()=>Response.json({output:{audio:{url:'https://example.com/voice.mp3'}}})),/无效音频地址/);
});
test('natural sounds and music generate a checked audio source before costly video submission',async()=>{
 const requests:any[]=[];
 const fetcher=async(endpoint:RequestInfo|URL,init?:RequestInit)=>{
  if(String(endpoint).includes('/sound.wav'))return new Response(sampleWav(5));
  requests.push(JSON.parse(String(init?.body)));
  return Response.json({output:{audio:{url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/sound.wav'}}});
 };
 const sound=await synthesizeVideoSound(c,{...plan,audioMode:'ambient'},fetcher as typeof fetch);
 assert.equal(sound.duration,5);assert.equal(requests[0].model,'qwen-audio-3.1-tts-next');assert.match(requests[0].input.text_prompt,/环境音效/);
 await synthesizeVideoSound(c,{...plan,audioMode:'music'},fetcher as typeof fetch);
 assert.match(requests[1].input.text_prompt,/纯器乐/);
 await assert.rejects(()=>synthesizeVideoSound(c,{...plan,audioMode:'music'},async()=>Response.json({code:'AccessDenied',message:'not enabled'},{status:403})),/声音生成失败/);
 await assert.rejects(()=>synthesizeVideoSound(c,{...plan,audioMode:'ambient'},async(endpoint)=>{if(String(endpoint).includes('/sound.wav')){const silent=sampleWav(5);silent.fill(0,44);return new Response(silent);}return Response.json({output:{audio:{url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/sound.wav'}}});}),/没有可听见的声音/);
});
test('narration duration rejects clipped speech and avoids long silent tails',()=>{
 assert.equal(matchedVideoDuration(wavDurationSeconds(sampleWav(3.25))),4);
 const streaming=sampleWav(3.25);streaming.writeUInt32LE(2147483583,4);streaming.writeUInt32LE(2147483547,40);
 assert.equal(wavDurationSeconds(streaming),3.25);
 const truncated=sampleWav(3.25).subarray(0,-100);
 assert.throws(()=>wavDurationSeconds(truncated),/配音文件不完整/);
 assert.throws(()=>matchedVideoDuration(1.5),/不足 2 秒/);
 assert.throws(()=>matchedVideoDuration(15.2),/超过 15 秒/);
 assert.throws(()=>wavDurationSeconds(new Uint8Array([1,2,3])),/有效的 WAV/);
});
test('a seller-authored video prompt is kept verbatim for review and submission',()=>{
 const custom=createCustomVideoPlan('  Slow camera orbit around the exact product; no people.  ',['asset_1','asset_2']);
 assert.equal(custom.prompt,'Slow camera orbit around the exact product; no people.');
 assert.equal(custom.sourceFileId,'asset_1');
 assert.throws(()=>createCustomVideoPlan('   ',['asset_1']),/请填写/);
});
test('a definite account denial can be retried with a fresh video job without exposing provider prose',async()=>{
 await assert.rejects(
  ()=>submitWanVideo(c,plan,'data:image/png;base64,AAA',async()=>Response.json({code:'Arrearage',message:'Access denied, please make sure your account is in good standing. For details, see: https://help.aliyun.com/zh/model-studio/error-code#overdue-payment'},{status:400}),'https://example.aliyuncs.com/sound.wav'),
  (error:unknown)=>error instanceof WanVideoRequestError && /视频 API Key 对应账号/.test(error.message) && !/https:\/\//.test(error.message),
 );
 assert.equal(isReusableVideoJob({status:'FAILED',error:'账号欠费'}),false);
 assert.equal(isReusableVideoJob({status:'SUBMISSION_UNKNOWN',error:'提交结果未确认：Access denied, please make sure your account is in good standing. https://help.aliyun.com/zh/model-studio/error-code#overdue-payment'}),false);
 assert.equal(isReusableVideoJob({status:'SUBMISSION_UNKNOWN',error:'网络超时'}),true);
 assert.equal(isReusableVideoJob({status:'PENDING'}),true);
});
