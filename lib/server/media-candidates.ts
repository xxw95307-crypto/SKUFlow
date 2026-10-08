import {videoMediaType} from '../domain/video-trim.ts';
import type {MediaCandidate} from '../agents/media-ordering.ts';
export interface StoredMediaCandidate extends MediaCandidate {objectKey:string;contentType:string;sceneId:string}
export async function getSelectedMedia(DB:D1Database,taskId:string,ids:string[]):Promise<StoredMediaCandidate[]> {
 if(!ids.length||ids.length>36||new Set(ids).size!==ids.length)throw new Error('请选择1–36项不重复的图片或视频');
 const results:StoredMediaCandidate[]=[];
 for(const id of ids) {
  if(id.startsWith('video_')) {
   const r=await DB.prepare("SELECT object_key,plan_json,source_file_id FROM video_jobs WHERE task_id=? AND id=? AND status='SUCCEEDED'").bind(taskId,id).first<{object_key:string;plan_json:string;source_file_id:string}>();
   if(!r?.object_key)throw new Error('选中视频不属于当前商品或尚未生成成功');const p=JSON.parse(r.plan_json);
   const source=await DB.prepare("SELECT scene_id FROM generated_assets WHERE task_id=? AND id=?").bind(taskId,r.source_file_id).first<{scene_id:string}>();
   results.push({id,type:'VIDEO',title:p.title,purpose:p.shots.join('；'),url:`/api/tasks/${taskId}/videos/${id}/file`,objectKey:r.object_key,contentType:videoMediaType(p),sceneId:source?.scene_id??'base'});
  }else {
   const r=await DB.prepare("SELECT object_key,content_type,title,asset_kind,note,scene_id FROM generated_assets WHERE task_id=? AND id=? AND status='COMPLETED'").bind(taskId,id).first<{object_key:string;content_type:string;title:string;asset_kind:string;note:string;scene_id:string}>();
   if(!r?.object_key||!r.content_type.startsWith('image/'))throw new Error('选中图片不属于当前商品或尚未生成成功');
   results.push({id,type:'IMAGE',title:r.title,purpose:`${r.asset_kind}：${r.note}`,url:`/api/tasks/${taskId}/generated-assets/${id}/file`,objectKey:r.object_key,contentType:r.content_type,sceneId:r.scene_id});
  }
 }
 if(!results.some(c=>c.type==='IMAGE'))throw new Error('媒体编排需要至少一张商品图片作为封面');
 return results;
}
