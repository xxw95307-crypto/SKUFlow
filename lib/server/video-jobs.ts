import {ensureSchema,getBindings} from '@/db/client';
import {getProductPassport} from '@/lib/server/passport-store';
import {loadWanVideoConfig,requireWanConfig,submitWanVideo,queryWanVideo,WanVideoRequestError} from '@/lib/ai/wan-video';
interface VideoJobRow { id:string; task_id:string; source_file_id:string; plan_json:string; status:string; provider_task_id:string|null; error:string|null; }
const publicJob=(r:VideoJobRow)=>({id:r.id,status:r.status,plan:JSON.parse(r.plan_json),error:r.error,videoUrl:r.status==='SUCCEEDED'?`/api/tasks/${r.task_id}/videos/${r.id}/file`:null});
export async function updateVideoJob(req:Request,ctx:{params:Promise<{taskId:string}>}) {
 try {await ensureSchema();const {taskId}=await ctx.params;const {id,action,prompt}=await req.json() as {id:string;action:string;prompt?:unknown};if(!['start','refresh'].includes(action))return Response.json({error:'无效操作'},{status:400});const b=getBindings();let job=await b.DB.prepare('SELECT * FROM video_jobs WHERE task_id=? AND id=?').bind(taskId,id).first<VideoJobRow>();if(!job)return Response.json({error:'视频任务不存在'},{status:404});const c=loadWanVideoConfig(b);
 if(action==='start'&&job.status==='DRAFT') {
 requireWanConfig(c);const p=await getProductPassport(b.DB,taskId);if(!p||p.conflicts.some(v=>v.status==='OPEN')||p.platformDrafts.some(d=>!['APPROVED','DRAFT_CREATED'].includes(d.status)))throw new Error('请先完成 Listing 确认');
 const source=await b.DB.prepare("SELECT object_key,content_type FROM generated_assets WHERE task_id=? AND id=? AND status='COMPLETED' AND object_key IS NOT NULL").bind(taskId,job.source_file_id).first<{object_key:string;content_type:string}>()
   ?? await b.DB.prepare('SELECT object_key,content_type FROM task_files WHERE task_id=? AND id=?').bind(taskId,job.source_file_id).first<{object_key:string;content_type:string}>();
 if(!source)throw new Error('已选首帧图片不存在');const image=await b.UPLOADS.get(source.object_key);if(!image)throw new Error('首帧图片内容不存在');const bytes=new Uint8Array(await image.arrayBuffer());if(bytes.length>20*1024*1024)throw new Error('首帧图片超过20MB');
 const editedPrompt=typeof prompt==='string'?prompt.trim():JSON.parse(job.plan_json).prompt;
 if(!editedPrompt||editedPrompt.length>4000)return Response.json({error:'请填写不超过 4000 字的视频生成提示词'},{status:400});
 const plan={...JSON.parse(job.plan_json),prompt:editedPrompt};
 const lock=await b.DB.prepare("UPDATE video_jobs SET status='SUBMITTING',plan_json=? WHERE id=? AND task_id=? AND status='DRAFT'").bind(JSON.stringify(plan),id,taskId).run();if(!lock.meta.changes)return Response.json({job:publicJob(job)});
 try {let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));const providerId=await submitWanVideo(c,plan,`data:${source.content_type};base64,${btoa(text)}`);await b.DB.prepare("UPDATE video_jobs SET status='PENDING',provider_task_id=? WHERE id=?").bind(providerId,id).run();}
 catch(e){
  const rejected=e instanceof WanVideoRequestError;
  await b.DB.prepare('UPDATE video_jobs SET status=?,error=? WHERE id=?')
   .bind(rejected?'FAILED':'SUBMISSION_UNKNOWN',rejected?(e as Error).message:'提交结果未确认：'+(e as Error).message,id).run();
  throw e;
 }
 }
 if(action==='refresh'&&['PENDING','RUNNING'].includes(job.status)) {
 if(!job.provider_task_id)throw new Error('视频服务任务 ID 缺失，请核对服务记录');const out=await queryWanVideo(c,job.provider_task_id);if(out.task_status==='SUCCEEDED') {
 const r=await fetch(out.video_url!,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('视频下载失败，稍后可继续查询原任务');if(Number(r.headers.get('content-length'))>100*1024*1024)throw new Error('视频超过100MB');const bytes=await r.arrayBuffer();if(bytes.byteLength>100*1024*1024)throw new Error('视频超过100MB');const key=`generated/${taskId}/videos/${id}.mp4`;await b.UPLOADS.put(key,bytes,{httpMetadata:{contentType:'video/mp4'}});await b.DB.prepare("UPDATE video_jobs SET status='SUCCEEDED',object_key=?,error=NULL WHERE id=?").bind(key,id).run();
 } else await b.DB.prepare('UPDATE video_jobs SET status=?,error=? WHERE id=?').bind(out.task_status,['FAILED','CANCELED','UNKNOWN'].includes(out.task_status)?out.message??'视频生成任务未成功':null,id).run();
 }
 job=await b.DB.prepare('SELECT * FROM video_jobs WHERE task_id=? AND id=?').bind(taskId,id).first<VideoJobRow>();if(!job)throw new Error('视频任务状态读取失败');return Response.json({job:publicJob(job)});
 }catch(e){return Response.json({error:(e as Error).message},{status:502});}
}
