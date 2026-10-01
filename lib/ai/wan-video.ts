export interface WanVideoConfig { apiKey:string; baseUrl:string; model:string }
export type VideoAudioMode = 'ambient' | 'music' | 'narration';
export interface VideoPlan {title:string;prompt:string;duration:number;resolution:'720P'|'1080P';sourceFileId:string;shots:string[];narrationSuggestion?:string;audioMode?:VideoAudioMode;narrationText?:string}
export class WanVideoRequestError extends Error {
 constructor(message:string) {super(message);this.name='WanVideoRequestError';}
}
export function loadWanVideoConfig(e:{BAILIAN_API_KEY?:string;BAILIAN_VIDEO_API_KEY?:string;BAILIAN_VIDEO_BASE_URL?:string;BAILIAN_VIDEO_MODEL?:string}):WanVideoConfig {
 return {apiKey:e.BAILIAN_VIDEO_API_KEY?.trim()||e.BAILIAN_API_KEY?.trim()||'',baseUrl:e.BAILIAN_VIDEO_BASE_URL?.trim().replace(/\/$/,'')||'https://dashscope.aliyuncs.com/api/v1',model:e.BAILIAN_VIDEO_MODEL?.trim()||'wan2.7-i2v'};
}
export function requireWanConfig(c:WanVideoConfig) {
 if(!c.apiKey||!c.baseUrl)throw new Error('视频服务未配置：需要配置 BAILIAN_API_KEY 或 BAILIAN_VIDEO_API_KEY；视频使用百炼 /api/v1 接口，调用权限与费用由百炼服务决定。');
 const u=new URL(c.baseUrl);if(u.protocol!=='https:'||!u.hostname.endsWith('.aliyuncs.com')||!u.pathname.endsWith('/api/v1')||u.username||u.password||u.search||u.hash||u.hostname.startsWith('token-plan.'))throw new Error('视频接口必须为百炼 HTTPS /api/v1 地址，不能使用聊天 compatible-mode 或 token-plan 地址');
 if(!/^wan2\.7-i2v(?:-\d{4}-\d{2}-\d{2})?$/.test(c.model))throw new Error('当前视频连接器仅支持 wan2.7-i2v 系列');
}
export function parseVideoPlan(raw:any,sourceIds:string[]):VideoPlan {
 if(!raw||typeof raw.title!=='string'||!raw.title.trim()||typeof raw.prompt!=='string'||!raw.prompt.trim()||!sourceIds.includes(raw.sourceFileId)||!Number.isInteger(raw.duration)||raw.duration<2||raw.duration>15||!['720P','1080P'].includes(raw.resolution)||!Array.isArray(raw.shots)||!raw.shots.length||!raw.shots.every((s:any)=>typeof s==='string'))throw new Error('视频策划结果无效');
 return {title:raw.title.slice(0,120),prompt:raw.prompt.slice(0,4000),duration:raw.duration,resolution:raw.resolution,sourceFileId:raw.sourceFileId,shots:raw.shots.slice(0,8).map((s:string)=>s.slice(0,300)),...(typeof raw.narrationSuggestion==='string'?{narrationSuggestion:raw.narrationSuggestion.slice(0,60)}:{}),...(raw.audioMode?{audioMode:raw.audioMode}:{}),...(raw.narrationText?{narrationText:raw.narrationText}:{})};
}
export function createCustomVideoPlan(prompt: string, sourceIds: string[]): VideoPlan {
 const trimmed=prompt.trim();
 if(!trimmed||trimmed.length>4000||!sourceIds.length)throw new Error('请填写不超过 4000 字的视频生成提示词，并确认至少一张图片');
 return parseVideoPlan({title:'自定义商品视频',prompt:trimmed,duration:5,resolution:'720P',sourceFileId:sourceIds[0],shots:['按商家提示词生成']},sourceIds);
}
async function api(c:WanVideoConfig,path:string,body:unknown|undefined,fetcher:typeof fetch) {
 requireWanConfig(c);const r=await fetcher(c.baseUrl+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${c.apiKey}`,'content-type':'application/json',...(body?{'X-DashScope-Async':'enable'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 const d=await r.json() as any;
 if(!r.ok||d.code||!d.output) {
  const detail=String(d.message??d.code??r.status);
  if(d.code==='Arrearage'||/overdue-payment|account is in good standing/i.test(detail)) {
   throw new WanVideoRequestError('视频服务所属阿里云账号存在欠费或账户状态异常。请检查视频 API Key 对应账号的费用与账单；恢复后重试当前步骤。');
  }
  const message=`视频服务拒绝了请求（${String(d.code??`HTTP ${r.status}`).slice(0,60)}）：${detail.slice(0,240)}`;
  if(!r.ok||d.code) throw new WanVideoRequestError(message);
  throw new Error(message);
 }
 return d.output;
}
export function prepareVideoAudio(plan:VideoPlan,audioUrl?:string) {
 const mode=plan.audioMode??'ambient';
 if(!['ambient','music','narration'].includes(mode))throw new Error('声音方式无效');
 const narration=plan.narrationText?.trim()??'';
 if(mode==='narration'&&(!narration||narration.length>60||!audioUrl))throw new Error('请填写不超过 60 字的解说文案，并生成配音');
 const suffix=mode==='music'?'配轻柔、自然的纯音乐，节奏贴合镜头；不要人声、歌词或口播。':mode==='narration'?'使用提供的配音作为画外解说，镜头只展示商品；不要让画面人物对口型，不要额外生成对白或背景音乐。':'只保留与画面相符的自然环境音效；不要背景音乐、口播或对白。';
 return {prompt:`${plan.prompt.trim()}\n声音要求：${suffix}`,media:audioUrl?[{type:'driving_audio',url:audioUrl}]:[]};
}
export async function synthesizeNarration(c:WanVideoConfig,text:string,fetcher:typeof fetch=fetch):Promise<string> {
 requireWanConfig(c);
 const script=text.trim();if(!script||script.length>60)throw new Error('请填写不超过 60 字的解说文案');
 const response=await fetcher(c.baseUrl+'/services/audio/tts/SpeechSynthesizer',{method:'POST',headers:{Authorization:`Bearer ${c.apiKey}`,'content-type':'application/json'},body:JSON.stringify({model:'qwen-audio-3.0-tts-flash',input:{text:script,voice:'longanhuan_v3.6',format:'mp3',sample_rate:24000}}),signal:AbortSignal.timeout(60_000)});
 const payload=await response.json() as {code?:string;message?:string;output?:{audio?:{url?:string}}};
 if(!response.ok||payload.code||!payload.output?.audio?.url)throw new Error(`配音生成失败：${String(payload.message??payload.code??response.status).slice(0,180)}`);
 const url=new URL(payload.output.audio.url);
 if(!['http:','https:'].includes(url.protocol)||!url.hostname.endsWith('.aliyuncs.com')||url.username||url.password)throw new Error('配音服务返回了无效音频地址');
 return url.toString();
}
export async function submitWanVideo(c:WanVideoConfig,plan:VideoPlan,image:string,fetcher:typeof fetch=fetch,audioUrl?:string):Promise<string> {
 parseVideoPlan(plan,[plan.sourceFileId]);if(!/^data:image\/(png|jpeg|webp|bmp);base64,/.test(image))throw new Error('视频首帧图片格式不支持');
 const audio=prepareVideoAudio(plan,audioUrl);
 const out=await api(c,'/services/aigc/video-generation/video-synthesis',{model:c.model,input:{prompt:audio.prompt,negative_prompt:'商品变形、颜色变化、虚构功能、错误文字',media:[{type:'first_frame',url:image},...audio.media]},parameters:{duration:plan.duration,resolution:plan.resolution,prompt_extend:false,watermark:true}},fetcher);
 if(typeof out.task_id!=='string'||!out.task_id)throw new Error('视频服务未返回任务 ID');return out.task_id;
}
export async function queryWanVideo(c:WanVideoConfig,id:string,fetcher:typeof fetch=fetch) {
 const out=await api(c,`/tasks/${encodeURIComponent(id)}`,undefined,fetcher);
 if(!['PENDING','RUNNING','SUCCEEDED','FAILED','CANCELED','UNKNOWN'].includes(out.task_status))throw new Error('视频任务状态无效');
 if(out.task_status==='SUCCEEDED') {const u=new URL(out.video_url);if(u.protocol!=='https:'||!u.hostname.endsWith('.aliyuncs.com')||u.username||u.password)throw new Error('视频结果地址无效');}
 return out as {task_status:string;video_url?:string;message?:string};
}
