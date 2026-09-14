import {videoMediaType} from '@/lib/domain/video-trim';
import { withAuthentication } from '@/lib/server/auth';
import {ensureSchema,getBindings} from '@/db/client';
export const dynamic='force-dynamic';
async function handleGET(req:Request,ctx:{params:Promise<{taskId:string;videoId:string}>}) {
 await ensureSchema();const {taskId,videoId}=await ctx.params;const b=getBindings();const row=await b.DB.prepare("SELECT object_key,plan_json FROM video_jobs WHERE task_id=? AND id=? AND status='SUCCEEDED'").bind(taskId,videoId).first<{object_key:string;plan_json:string}>();if(!row)return new Response('Not found',{status:404});const object=await b.UPLOADS.get(row.object_key,{range:req.headers});if(!object)return new Response('Not found',{status:404});
 const headers=new Headers({'content-type':videoMediaType(JSON.parse(row.plan_json)),'accept-ranges':'bytes','cache-control':'private, max-age=3600','x-content-type-options':'nosniff'});let status=200;if(object.range&&'offset' in object.range){const offset=object.range.offset??0;const length=object.range.length??object.size;headers.set('content-range',`bytes ${offset}-${offset+length-1}/${object.size}`);headers.set('content-length',String(length));status=206;}return new Response(object.body,{status,headers});
}

export const GET = withAuthentication(handleGET);
