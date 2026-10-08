import { withAuthentication } from '@/lib/server/auth';
import {ensureSchema,getBindings} from '@/db/client';
import {getSelectedMedia} from '@/lib/server/media-candidates';
import {planMediaOrder,parseSceneMediaOrderPlan,mediaCandidatesForScene,sameSceneMediaSelection} from '@/lib/agents/media-ordering';
import {getProductPassport} from '@/lib/server/passport-store';
import {loadBailianConfig} from '@/lib/config/bailian';
import {getScenePlan} from '@/lib/server/scene-plan-store';
export const dynamic='force-dynamic';
async function handleGET(_r:Request,ctx:{params:Promise<{taskId:string}>}) {
 try {await ensureSchema();const {taskId}=await ctx.params;const row=await getBindings().DB.prepare('SELECT * FROM media_order_plans WHERE task_id=? ORDER BY created_at DESC LIMIT 1').bind(taskId).first<any>();return Response.json({plan:row?{id:row.id,status:row.status,...JSON.parse(row.plan_json)}:null});}catch(e){return Response.json({error:(e as Error).message},{status:500});}
}
async function handlePOST(req:Request,ctx:{params:Promise<{taskId:string}>}) {
 try {await ensureSchema();const {taskId}=await ctx.params;const b=getBindings();const body=await req.json() as {selectedAssetIds?:unknown;guidance?:string};const ids=Array.isArray(body.selectedAssetIds)&&body.selectedAssetIds.every(i=>typeof i==='string')?body.selectedAssetIds as string[]:[];
 const passport=await getProductPassport(b.DB,taskId);if(!passport)return Response.json({error:'商品任务不存在'},{status:404});if(passport.conflicts.some(c=>c.status==='OPEN')||passport.platformDrafts.some(d=>d.status!=='APPROVED'))return Response.json({error:'请先确认所有 Listing，已发布商品请新建任务修改'},{status:409});
 const candidates=await getSelectedMedia(b.DB,taskId,ids);const previous=await b.DB.prepare('SELECT plan_json FROM media_order_plans WHERE task_id=? ORDER BY created_at DESC LIMIT 1').bind(taskId).first<{plan_json:string}>();
 const scenePlan=await getScenePlan(b.DB,taskId);const split=scenePlan?.mode==='SPLIT';
 const sceneIds=split?scenePlan.scenes.map(scene=>scene.id):['base'];
 const previousGroups=(previous?JSON.parse(previous.plan_json):null)?.groups??[];
 const config=loadBailianConfig(b);
 const groups=await Promise.all(sceneIds.map(async(sceneId)=>{
  const own=mediaCandidatesForScene(candidates,sceneId,split);
  if(!own.length)throw new Error(`场景 ${sceneId} 缺少已选择的图片`);
  const images:Array<{id:string;url:string}>=[];let total=0;
  for(const candidate of own.filter(item=>item.type==='IMAGE')){
   const object=await b.UPLOADS.get(candidate.objectKey);if(!object)throw new Error('图片内容不存在');
   if(object.size>4*1024*1024||total+object.size>8*1024*1024)continue;
   const bytes=new Uint8Array(await object.arrayBuffer());total+=bytes.length;let str='';
   for(let index=0;index<bytes.length;index+=8192)str+=String.fromCharCode(...bytes.subarray(index,index+8192));
   images.push({id:candidate.id,url:`data:${candidate.contentType};base64,${btoa(str)}`});
  }
  const prior=previousGroups.find((group:{sceneId:string})=>group.sceneId===sceneId);
  const scene=scenePlan?.scenes.find(item=>item.id===sceneId);
  const destinations=passport.platformDrafts.filter(draft=>draft.sceneId===sceneId).map(draft=>({platformId:draft.platformId,market:draft.market}));
  const plan=await planMediaOrder(config,{candidates:own.map(({objectKey,contentType,...candidate})=>candidate),facts:passport.facts.filter(f=>f.value!==null&&!['MISSING','CONFLICT'].includes(f.status)),platforms:{sceneName:scene?.name,visualBrief:scene?.visualBrief,copyBrief:scene?.copyBrief,destinations},guidance:typeof body.guidance==='string'?body.guidance.slice(0,1000):'',previousPlan:prior??null,images});
  return {sceneId,...plan};
 }));
 const plan=parseSceneMediaOrderPlan({groups},candidates,sceneIds,split);
 const id=`media_plan_${crypto.randomUUID()}`;await b.DB.prepare("INSERT INTO media_order_plans (id,task_id,status,plan_json,created_at) VALUES (?,?,'DRAFT',?,?)").bind(id,taskId,JSON.stringify({...plan,candidates:candidates.map(({objectKey,contentType,...c})=>c)}),new Date().toISOString()).run();return Response.json({plan:{id,status:'DRAFT',...plan,candidates:candidates.map(({objectKey,contentType,...c})=>c)}});
 }catch(e){return Response.json({error:(e as Error).message},{status:502});}
}
async function handlePATCH(req:Request,ctx:{params:Promise<{taskId:string}>}) {
 try {await ensureSchema();const {taskId}=await ctx.params;const {id,selectedAssetIds}=await req.json() as {id:string;selectedAssetIds:string[]};const b=getBindings();const row=await b.DB.prepare('SELECT * FROM media_order_plans WHERE id=? AND task_id=?').bind(id,taskId).first<any>();if(!row)return Response.json({error:'媒体方案不存在'},{status:404});const raw=JSON.parse(row.plan_json);const candidates=await getSelectedMedia(b.DB,taskId,selectedAssetIds);const scenePlan=await getScenePlan(b.DB,taskId);const split=scenePlan?.mode==='SPLIT';const sceneIds=split?scenePlan.scenes.map(scene=>scene.id):['base'];const plan=parseSceneMediaOrderPlan(raw,candidates,sceneIds,split);if(!sameSceneMediaSelection(plan,selectedAssetIds,sceneIds))throw new Error('素材选择已改变，请重新安排媒体');const latest=await b.DB.prepare('SELECT id FROM media_order_plans WHERE task_id=? ORDER BY created_at DESC LIMIT 1').bind(taskId).first<{id:string}>();if(latest?.id!==id)throw new Error('已有更新方案，请确认最新版');await b.DB.prepare("UPDATE media_order_plans SET status='CONFIRMED' WHERE id=? AND task_id=?").bind(id,taskId).run();return Response.json({plan:{id,status:'CONFIRMED',...raw}});
 }catch(e){return Response.json({error:(e as Error).message},{status:409});}
}

export const GET = withAuthentication(handleGET);
export const POST = withAuthentication(handlePOST);
export const PATCH = withAuthentication(handlePATCH);
