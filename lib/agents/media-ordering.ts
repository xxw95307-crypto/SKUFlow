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
export function completeMediaOrderPlan(raw:unknown,candidates:MediaCandidate[]):MediaOrderPlan {
 const supplied=raw&&typeof raw==='object'&&Array.isArray((raw as {items?:unknown}).items)?(raw as {items:unknown[]}).items:[];
 const byId=new Map(candidates.map(candidate=>[candidate.id,candidate]));
 const seen=new Set<string>();
 const ordered:Array<{candidate:MediaCandidate;supplied:Record<string,unknown>|null}>=[];
 for(const value of supplied){
  if(!value||typeof value!=='object'||Array.isArray(value))continue;
  const item=value as Record<string,unknown>;
  const candidate=typeof item.id==='string'?byId.get(item.id):undefined;
  if(!candidate||seen.has(candidate.id))continue;
  seen.add(candidate.id);ordered.push({candidate,supplied:item});
 }
 for(const candidate of candidates)if(!seen.has(candidate.id))ordered.push({candidate,supplied:null});
 const firstImage=ordered.findIndex(item=>item.candidate.type==='IMAGE');
 if(firstImage<0)throw new Error('媒体编排需要至少一张商品图片作为封面');
 if(firstImage>0)ordered.unshift(ordered.splice(firstImage,1)[0]);
 return parseMediaOrderPlan({items:ordered.map(({candidate,supplied},index)=>({
  id:candidate.id,
  role:index===0?'COVER':candidate.type==='VIDEO'?'VIDEO':'GALLERY',
  alt:typeof supplied?.alt==='string'&&supplied.alt.trim()?supplied.alt.trim():candidate.title,
  reason:typeof supplied?.reason==='string'&&supplied.reason.trim()?supplied.reason.trim():'保留已选素材，按选图顺序放在后面供确认',
 }))},candidates);
}
export async function planMediaOrder(config:{apiKey:string;baseUrl:string;model:string},input:{candidates:MediaCandidate[];facts:unknown;platforms:unknown;guidance?:string;previousPlan?:unknown;images?:Array<{id:string;url:string}>},fetcher:typeof fetch=fetch):Promise<MediaOrderPlan> {
 if(!config.apiKey||!config.baseUrl||!config.model)throw new Error('媒体编排模型未配置');
 const metadata={...input,images:input.images?.map(image=>({id:image.id})),expectedIds:input.candidates.map(candidate=>candidate.id)};
 let salvage:unknown=null;
 for(let attempt=0;attempt<2;attempt++){
  const message:Array<{type:'text';text:string}|{type:'image_url';image_url:{url:string}}>=[{type:'text',text:JSON.stringify(metadata)}];
  if(attempt===0)for(const image of input.images??[])message.push({type:'text',text:`素材ID：${image.id}`},{type:'image_url',image_url:{url:image.url}});
  else message.push({type:'text',text:`上一版遗漏或重复了素材。只按以下 ${input.candidates.length} 个 ID 输出，每个恰好一次：${input.candidates.map(candidate=>candidate.id).join('、')}`});
  const response=await fetcher(config.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`,'content-type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({model:config.model,enable_thinking:false,response_format:{type:'json_object'},temperature:0.2,max_completion_tokens:7000,messages:[{role:'system',content:'你是跨境商品媒体编排 Agent。仅编排卖家已选择的图片和视频，根据已确认商品事实、目标平台、图片内容和素材用途决定封面及观看顺序。第一项必须为清晰展示商品的图片COVER；后续图片为GALLERY、视频为VIDEO。每项素材恰好出现一次，不能遗漏、重复或改写 ID。不固定视频位置，不默认选中任何额外素材。说明每项的安排理由，编写忠于商品事实和素材内容的中文alt。不要把AI视频的创作动作当成商品事实。响应JSON {items:[{id,role,alt,reason}]}，数组顺序即商品媒体顺序。用户修改顺序要求应优先遵循，但封面必须图片。'}, {role:'user',content:message}]})});
  if(!response.ok)throw new Error('媒体编排模型请求失败');
  const payload=await response.json() as {choices?:Array<{message?:{content?:string}}>};
  const content=payload.choices?.[0]?.message?.content??'';
  try{
   const raw=JSON.parse(content.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')) as unknown;
   salvage=raw;
   return parseMediaOrderPlan(raw,input.candidates);
  }catch{ /* Retry with explicit IDs, then preserve every seller-selected item below. */ }
 }
 return completeMediaOrderPlan(salvage,input.candidates);
}
