export interface MediaCandidate {id:string;type:'IMAGE'|'VIDEO';title:string;purpose:string;url?:string}
export interface MediaPlacement {id:string;role:'COVER'|'GALLERY'|'VIDEO';alt:string;reason:string}
export interface MediaOrderPlan {items:MediaPlacement[]}
export function parseMediaOrderPlan(raw:unknown,candidates:MediaCandidate[]):MediaOrderPlan {
 const items=(raw as any)?.items;
 if(!Array.isArray(items)||items.length!==candidates.length||!items.length||new Set(items.map(i=>i?.id)).size!==items.length)throw new Error('媒体方案必须包含每一项已选素材且不能重复');
 const byId=new Map(candidates.map(c=>[c.id,c]));
 for(const [index,item] of items.entries()) {
  const c=byId.get(item?.id);
  if(!c||typeof item.alt!=='string'||!item.alt.trim()||typeof item.reason!=='string'||!item.reason.trim())throw new Error('媒体方案包含未知素材或缺少安排理由');
  if(index===0 ? c.type!=='IMAGE'||item.role!=='COVER' : item.role!==(c.type==='VIDEO'?'VIDEO':'GALLERY'))throw new Error('封面必须是第一张图片，后续素材须按真实类型安排');
 }
 return {items:items.map(i=>({id:i.id,role:i.role,alt:i.alt.trim().slice(0,240),reason:i.reason.trim().slice(0,400)}))};
}
export function sameMediaSelection(plan:MediaOrderPlan,ids:string[]):boolean {
 return plan.items.length===ids.length&&new Set(ids).size===ids.length&&plan.items.every(i=>ids.includes(i.id));
}
export async function planMediaOrder(config:{apiKey:string;baseUrl:string;model:string},input:{candidates:MediaCandidate[];facts:unknown;platforms:unknown;guidance?:string;previousPlan?:unknown;images?:Array<{id:string;url:string}>},fetcher:typeof fetch=fetch):Promise<MediaOrderPlan> {
 if(!config.apiKey||!config.baseUrl||!config.model)throw new Error('媒体编排模型未配置');
 const message:any[]=[{type:'text',text:JSON.stringify({...input,images:input.images?.map(i=>({id:i.id}))})}];
 for(const image of input.images??[])message.push({type:'text',text:`素材ID：${image.id}`},{type:'image_url',image_url:{url:image.url}});
 const r=await fetcher(config.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`,'content-type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({model:config.model,enable_thinking:false,response_format:{type:'json_object'},temperature:0.2,max_completion_tokens:4000,messages:[{role:'system',content:'你是跨境商品媒体编排 Agent。仅编排卖家已选择的图片和视频，根据已确认商品事实、目标平台、图片内容和素材用途决定封面及观看顺序。第一项必须为清晰展示商品的图片COVER；后续图片为GALLERY、视频为VIDEO。每项素材恰好出现一次，不固定视频位置，不默认选中任何额外素材。说明每项的安排理由，编写忠于商品事实和素材内容的中文alt。不要把AI视频的创作动作当成商品事实。响应JSON {items:[{id,role,alt,reason}]}，数组顺序即商品媒体顺序。用户修改顺序要求应优先遵循，但封面必须图片。'}, {role:'user',content:message}]})});
 const d=await r.json() as any;if(!r.ok)throw new Error('媒体编排模型请求失败');const content=d.choices?.[0]?.message?.content??'';
 return parseMediaOrderPlan(JSON.parse(content.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')),input.candidates);
}
