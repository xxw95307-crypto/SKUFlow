export interface WanVideoConfig { apiKey:string; baseUrl:string; model:string }
export interface VideoPlan {title:string;prompt:string;duration:number;resolution:'720P'|'1080P';sourceFileId:string;shots:string[]}
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
 return {title:raw.title.slice(0,120),prompt:raw.prompt.slice(0,4000),duration:raw.duration,resolution:raw.resolution,sourceFileId:raw.sourceFileId,shots:raw.shots.slice(0,8).map((s:string)=>s.slice(0,300))};
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
export async function submitWanVideo(c:WanVideoConfig,plan:VideoPlan,image:string,fetcher:typeof fetch=fetch):Promise<string> {
 parseVideoPlan(plan,[plan.sourceFileId]);if(!/^data:image\/(png|jpeg|webp|bmp);base64,/.test(image))throw new Error('视频首帧图片格式不支持');
 const out=await api(c,'/services/aigc/video-generation/video-synthesis',{model:c.model,input:{prompt:plan.prompt,negative_prompt:'商品变形、颜色变化、虚构功能、错误文字',media:[{type:'first_frame',url:image}]},parameters:{duration:plan.duration,resolution:plan.resolution,prompt_extend:false,watermark:true}},fetcher);
 if(typeof out.task_id!=='string'||!out.task_id)throw new Error('视频服务未返回任务 ID');return out.task_id;
}
export async function queryWanVideo(c:WanVideoConfig,id:string,fetcher:typeof fetch=fetch) {
 const out=await api(c,`/tasks/${encodeURIComponent(id)}`,undefined,fetcher);
 if(!['PENDING','RUNNING','SUCCEEDED','FAILED','CANCELED','UNKNOWN'].includes(out.task_status))throw new Error('视频任务状态无效');
 if(out.task_status==='SUCCEEDED') {const u=new URL(out.video_url);if(u.protocol!=='https:'||!u.hostname.endsWith('.aliyuncs.com')||u.username||u.password)throw new Error('视频结果地址无效');}
 return out as {task_status:string;video_url?:string;message?:string};
}
