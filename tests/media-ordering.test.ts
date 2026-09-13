import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMediaOrderPlan,sameMediaSelection,planMediaOrder} from '../lib/agents/media-ordering.ts';
import {compareIntegratedProduct,reorderShopifyMedia,refreshMediaOrderStatus,publishIntegratedShopify} from '../lib/platforms/shopify-integrated.ts';
const candidates=[{id:'detail',type:'IMAGE' as const,title:'细节',purpose:'DETAIL'},{id:'hero',type:'IMAGE' as const,title:'全貌',purpose:'HERO'},{id:'video',type:'VIDEO' as const,title:'展示',purpose:'场景'}];
const raw={items:[{id:'hero',role:'COVER',alt:'商品全貌',reason:'商品清晰可见'},{id:'video',role:'VIDEO',alt:'商品展示视频',reason:'随后观看动作'},{id:'detail',role:'GALLERY',alt:'商品细节',reason:'最后核对细节'}]};
const config={storeDomain:'test.myshopify.com',clientId:'x',clientSecret:'y',apiVersion:'2026-07'};
test('agent order keeps exact seller selection with one image cover and freely placed video',()=>{
 const plan=parseMediaOrderPlan(raw,candidates);assert.equal(plan.items[1].role,'VIDEO');assert.equal(sameMediaSelection(plan,['detail','video','hero']),true);assert.equal(sameMediaSelection(plan,['hero','video']),false);
 assert.throws(()=>parseMediaOrderPlan({items:[raw.items[1],raw.items[0],raw.items[2]]},candidates),/封面/);
 assert.throws(()=>parseMediaOrderPlan({items:[raw.items[0],raw.items[0],raw.items[2]]},candidates),/重复/);
 assert.throws(()=>parseMediaOrderPlan({items:[raw.items[0],raw.items[1],{...raw.items[2],id:'other'}]},candidates),/未知/);
});
test('model receives product context and cannot invent or omit selected media',async()=>{
 const p=await planMediaOrder({apiKey:'test',baseUrl:'https://test',model:'qwen'},{candidates,facts:[],platforms:['shopify'],guidance:'视频放第二位'},async(_u,init)=>{assert.match(String(init?.body),/视频放第二位/);return Response.json({choices:[{message:{content:JSON.stringify(raw)}}]});});assert.equal(p.items[1].id,'video');
});
const expected={title:'t',variants:[],files:[{alt:'hero',contentType:'IMAGE'},{alt:'video',contentType:'VIDEO'},{alt:'detail',contentType:'IMAGE'}]};
const actual={title:'t',collections:{nodes:[]},variants:{nodes:[]},featuredMedia:{alt:'hero'},media:{nodes:[{id:'h',alt:'hero',mediaContentType:'IMAGE',status:'READY'},{id:'v',alt:'video',mediaContentType:'VIDEO',status:'PROCESSING'},{id:'d',alt:'detail',mediaContentType:'IMAGE',status:'READY'}]}};
test('readback verifies cover order media type and pending video independently',()=>{
 const r=compareIntegratedProduct(expected,actual);assert.equal(r.find(v=>v.field==='商品媒体顺序')?.status,'MATCH');assert.equal(r.find(v=>v.field==='商品封面')?.status,'MATCH');assert.equal(r.find(v=>v.field==='视频 video')?.status,'PENDING');
 const processingCover={...actual,featuredMedia:null,media:{nodes:actual.media.nodes.map(m=>({...m,status:'PROCESSING'}))}};assert.equal(compareIntegratedProduct(expected,processingCover).find(v=>v.field==='商品封面')?.status,'PENDING');
 const reversed={...actual,featuredMedia:{alt:'detail'},media:{nodes:[...actual.media.nodes].reverse()}};assert.equal(compareIntegratedProduct(expected,reversed).find(v=>v.field==='商品媒体顺序')?.status,'MISMATCH');
 assert.equal(compareIntegratedProduct({...expected,mediaOrderPending:true},reversed).find(v=>v.field==='商品媒体顺序')?.status,'PENDING');
});
test('reorder uses actual IDs and records asynchronous job; refresh only polls that job',async()=>{
 assert.equal(await reorderShopifyMedia(config,'t','p',expected.files,actual,async()=>{throw new Error('must not mutate correct order');}),null);
 const id=await reorderShopifyMedia(config,'t','p',expected.files,{...actual,media:{nodes:[...actual.media.nodes].reverse()}},async(_u,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.variables.moves[0].id,'h');assert.equal(body.variables.moves[1].newPosition,'1');return Response.json({data:{productReorderMedia:{job:{id:'job'},mediaUserErrors:[]}}});});assert.equal(id,'job');
 const done=await refreshMediaOrderStatus(config,'t',{mediaOrderJobId:'job'},async(_u,init)=>{assert.match(String(init?.body),/job\(id/);return Response.json({data:{job:{done:true}}});});assert.equal(done.mediaOrderPending,false);
});
test('video staged upload supplies byte size and binds VIDEO through productSet',async()=>{
 let input:any;const payload={fields:{title:'t',variant_sku:'test',variant_price:1,taxable:false,requires_shipping:false,inventory_tracked:false}} as any;
 const r=await publishIntegratedShopify({config,payload,draftId:'d',media:[{name:'v.mp4',contentType:'video/mp4',bytes:new ArrayBuffer(10),alt:'video'}]},async(url,init)=>{
 if(String(url).includes('access_token'))return Response.json({access_token:'t'});
 if(String(url)==='https://upload.test'){assert.ok(init?.body instanceof FormData);return new Response('',{status:201});}
 const body=JSON.parse(String(init?.body));const q=body.query;
 if(q.includes('accessScopes'))return Response.json({data:{currentAppInstallation:{accessScopes:[{handle:'write_products'}]}}});
 if(q.includes('products(first:2'))return Response.json({data:{products:{nodes:[]}}});
 if(q.includes('stagedUploadsCreate')){assert.equal(body.variables.input[0].resource,'VIDEO');assert.equal(body.variables.input[0].fileSize,'10');return Response.json({data:{stagedUploadsCreate:{stagedTargets:[{url:'https://upload.test',resourceUrl:'https://resource.test',parameters:[]}],userErrors:[]}}});}
 if(q.includes('productSet')){input=body.variables.input;return Response.json({data:{productSet:{product:{id:'gid://shopify/Product/1'},userErrors:[]}}});}
 throw new Error('simulate readback unavailable');
 });assert.equal(input.files[0].contentType,'VIDEO');assert.equal(r.submittedProduct?.files[0].contentType,'VIDEO');assert.equal(r.status,'DRAFT_CREATED');assert.equal(r.verification?.[0].status,'UNVERIFIED');
});
