import { normalizeSaleVariants, present, parseOptions, validateShopifyFields } from '../domain/shopify-validation.ts';
export { validateShopifyFields } from '../domain/shopify-validation.ts';
import { exchangeAccessToken, shopifyGraphql, buildShopifyProductInput, type ShopifyDevConfig, type ShopifyDevPublication } from './shopify-dev.ts';
import type { ListingDraftPayload } from '../domain/listing.ts';
export interface ShopifyVariantRow { options: string; sku: string; price: string | number; quantity?: string | number; barcode?: string; weight?: string | number }
export interface ShopifyMediaInput { name: string; contentType: string; bytes: ArrayBuffer; alt: string }
type Verification = NonNullable<ShopifyDevPublication['verification']>;
export function buildIntegratedProduct(payload: ListingDraftPayload, draftId: string, files: unknown[] = [], uniqueHandleForScene = false) {
  const f = {...payload.fields, variants: normalizeSaleVariants(payload.fields.variants)} as Record<string, any>;
  const errors=validateShopifyFields(f); if(errors.length) throw new Error(errors.join('；'));
  const product = buildShopifyProductInput(payload,draftId);
  for(const [key,target] of Object.entries({category_id:'category',handle:'handle',template_suffix:'templateSuffix',collection_ids:'collections'})) if(present(f[key])) product[target]=f[key];
  if (uniqueHandleForScene && present(f.handle)) product.handle = `${String(f.handle).slice(0, 180)}-${draftId.slice(-8)}`;
  const rows: ShopifyVariantRow[] = f.variants?.length ? f.variants : [{options:'Title=Default Title',sku:f.variant_sku,price:f.variant_price,quantity:f.inventory_quantity,barcode:f.barcode,weight:f.shipping_weight}];
  const opts=rows.map(r=>parseOptions(r.options));
  product.productOptions=Object.keys(opts[0]).map((name,i)=>({name,position:i+1,values:[...new Set(opts.map(o=>o[name]))].map(name=>({name}))}));
  product.variants=rows.map((r,i)=>({optionValues:Object.entries(opts[i]).map(([optionName,name])=>({optionName,name})),sku:r.sku.trim(),price:String(r.price),
    ...(present(r.barcode || f.barcode)?{barcode:r.barcode || f.barcode}:{}),
    ...(present(f.compare_at_price)?{compareAtPrice:String(f.compare_at_price)}:{}),taxable:f.taxable,
    ...(f.inventory_policy?{inventoryPolicy:f.inventory_policy}:{}),
    inventoryItem:{tracked:f.inventory_tracked,requiresShipping:f.requires_shipping,
      ...(present(r.weight ?? f.shipping_weight)?{measurement:{weight:{value:Number(r.weight ?? f.shipping_weight),unit:'KILOGRAMS'}}}:{}),
      ...(present(f.unit_cost)?{cost:String(f.unit_cost)}:{}),...(f.country_of_origin?{countryCodeOfOrigin:f.country_of_origin}:{}),...(f.hs_code?{harmonizedSystemCode:f.hs_code}:{})},
    ...(present(r.quantity)?{inventoryQuantities:[{locationId:f.inventory_location,name:'available',quantity:Number(r.quantity)}]}:{})}));
  if(files.length) product.files=files;
  return product;
}
export async function shopifyLookup(config: ShopifyDevConfig, kind: string, search = '', fetchImpl: typeof fetch = fetch) {
  const token=await exchangeAccessToken(config,fetchImpl);
  if(kind==='categories') {
    const d=await shopifyGraphql<any>(config,token,'query($s:String){taxonomy{categories(first:100,search:$s){nodes{id fullName}}}}',{s:search || null},fetchImpl);
    return d.taxonomy.categories.nodes.map((n:any)=>({value:n.id,label:n.fullName}));
  }
  if(kind==='collections') {
    const d=await shopifyGraphql<any>(config,token,'query($q:String){collections(first:100,query:$q){nodes{id title}}}',{q:search || null},fetchImpl);
    return d.collections.nodes.map((n:any)=>({value:n.id,label:n.title}));
  }
  if(kind==='locations') {
    const d=await shopifyGraphql<any>(config,token,'{locations(first:100){nodes{id name isActive}}}',{},fetchImpl);
    return d.locations.nodes.filter((n:any)=>n.isActive).map((n:any)=>({value:n.id,label:n.name}));
  }
  throw new Error('不支持的选项类型');
}
async function uploadMedia(config: ShopifyDevConfig, token:string, media:ShopifyMediaInput[], fetchImpl:typeof fetch) {
  const files=[];
  for(const item of media) {
    if(!['video/mp4','video/webm'].includes(item.contentType) && !item.contentType.startsWith('image/'))throw new Error('不支持的商品媒体类型');
    if(!item.bytes.byteLength)throw new Error('媒体文件为空');
    const d=await shopifyGraphql<any>(config,token,`mutation($input:[StagedUploadInput!]!){stagedUploadsCreate(input:$input){stagedTargets{url resourceUrl parameters{name value}} userErrors{message}}}`,{input:[{filename:item.name,mimeType:item.contentType,httpMethod:'POST',resource:['video/mp4','video/webm'].includes(item.contentType)?'VIDEO':'PRODUCT_IMAGE',...(['video/mp4','video/webm'].includes(item.contentType)?{fileSize:String(item.bytes.byteLength)}:{})}]},fetchImpl);
    if(d.stagedUploadsCreate.userErrors.length) throw new Error(d.stagedUploadsCreate.userErrors.map((e:any)=>e.message).join('；'));
    const target=d.stagedUploadsCreate.stagedTargets[0];if(!target)throw new Error('Shopify 未返回上传地址');
    const form=new FormData();for(const p of target.parameters)form.append(p.name,p.value);form.append('file',new Blob([item.bytes],{type:item.contentType}),item.name);
    const response=await fetchImpl(target.url,{method:'POST',body:form});if(!response.ok)throw new Error(`媒体上传失败 ${response.status}`);
    files.push({originalSource:target.resourceUrl,contentType:['video/mp4','video/webm'].includes(item.contentType)?'VIDEO':'IMAGE',alt:item.alt});
  }
  return files;
}
export async function publishIntegratedShopify(input:{config:ShopifyDevConfig;payload:ListingDraftPayload;draftId:string;media:ShopifyMediaInput[];uniqueHandleForScene?:boolean;onCreated?:(productId:string)=>Promise<void>},fetchImpl:typeof fetch=fetch):Promise<ShopifyDevPublication> {
  const {config,payload,draftId}=input;
  const expected=buildIntegratedProduct(payload,draftId,[],input.uniqueHandleForScene === true);
  const token=await exchangeAccessToken(config,fetchImpl);
  const access=await shopifyGraphql<any>(config,token,'{currentAppInstallation{accessScopes{handle}}}',{},fetchImpl);
  const scopes=access.currentAppInstallation.accessScopes.map((s:any)=>s.handle);
  const quantities=(expected.variants as any[]).some(v=>v.inventoryQuantities?.length);
  if(quantities && (!scopes.includes('write_inventory') || !scopes.includes('read_locations')))throw new Error('请先授权 Shopify 库存写入和地点读取权限（write_inventory、read_locations），再发布');
  if(quantities) { const locations=await shopifyLookup(config,'locations','',fetchImpl); if(!locations.some((l:any)=>l.value===payload.fields.inventory_location))throw new Error('库存地点无效或已停用'); }
  expected.files=input.media.map(m=>({alt:m.alt,contentType:['video/mp4','video/webm'].includes(m.contentType)?'VIDEO':'IMAGE'}));
  // Idempotent recovery: a previous request may have created the product before
  // its response was persisted. Never create another product for that draft.
  const existing=await shopifyGraphql<any>(config,token,'query($q:String!){products(first:2,query:$q){nodes{id}}}',{q:`tag:skuflow-draft-${draftId}`},fetchImpl);
  let id=existing.products.nodes[0]?.id as string|undefined;
  if(existing.products.nodes.length>1)throw new Error('检测到重复草稿，请先在 Shopify 核对');
  if(!id) {
    const files=await uploadMedia(config,token,input.media,fetchImpl);if(files.length)expected.files=files;else delete expected.files;
    const d=await shopifyGraphql<any>(config,token,`mutation($input:ProductSetInput!){productSet(input:$input,synchronous:true){product{id} userErrors{field message}}}`,{input:expected},fetchImpl);
    if(d.productSet.userErrors.length)throw new Error(d.productSet.userErrors.map((e:any)=>`${e.field?.join('.')}: ${e.message}`).join('；'));
    id=d.productSet.product?.id;if(!id)throw new Error('Shopify 未返回商品 ID');
  }
  await input.onCreated?.(id);
  const warnings:string[]=[];let verification:Verification=[];let variantId:string|null=null;let handle:string|null=null;
  try {
    let actual=await readIntegratedProduct(config,token,id,quantities,fetchImpl);
    const orderJob=await reorderShopifyMedia(config,token,id,(expected.files??[]) as any[],actual,fetchImpl);
    if(orderJob){expected.mediaOrderJobId=orderJob;expected.mediaOrderPending=true;actual=await readIntegratedProduct(config,token,id,quantities,fetchImpl);}

    verification=compareIntegratedProduct(expected,actual);
    variantId=actual.variants.nodes[0]?.id??null;handle=actual.handle;
    for(const v of verification)if(v.status!=='MATCH')warnings.push(`${v.field}：${v.status==='PENDING'?'Shopify 正在处理媒体，稍后需重新核对':'与提交值不一致'}`);
  }catch(e){verification=[{field:'product',status:'UNVERIFIED'}];warnings.push(`草稿已创建，回读失败：${(e as Error).message}。重试会核对原草稿，不会重新创建。`);}
  warnings.push('销售渠道、市场独立价格和分类/自定义元字段尚未写入；商品保持 DRAFT。');
  return {provider:'SHOPIFY_DEV',productId:id,variantId,handle,adminUrl:`https://${config.storeDomain}/admin/products/${id.split('/').pop()}`,status:'DRAFT_CREATED',createdAt:new Date().toISOString(),warnings,verification,submittedProduct:{...expected,files:input.media.map(m=>({alt:m.alt,contentType:['video/mp4','video/webm'].includes(m.contentType)?'VIDEO':'IMAGE'}))}};
}
export function compareIntegratedProduct(expected:Record<string,any>,actual:any):Verification {
  const result:Verification=[];
  const check=(field:string,e:unknown,a:unknown)=>{if(e===undefined)return;const norm=(v:unknown)=>Array.isArray(v)?[...v].sort():v;result.push({field,expected:e,actual:a,status:JSON.stringify(norm(e))===JSON.stringify(norm(a))?'MATCH':'MISMATCH'});};
  for(const key of ['title','descriptionHtml','vendor','productType','tags','status','handle','templateSuffix'])check(key,expected[key],actual[key]);
  check('category',expected.category,actual.category?.id);check('collections',expected.collections,actual.collections.nodes.map((n:any)=>n.id));
  for(const key of ['title','description'])check(`seo.${key}`,expected.seo?.[key],actual.seo?.[key]);
  check('变体数量',expected.variants.length,actual.variants.nodes.length);
  for(const [i,v] of expected.variants.entries()) {
    const a=actual.variants.nodes.find((n:any)=>v.optionValues.every((o:any)=>n.selectedOptions.some((s:any)=>s.name===o.optionName&&s.value===o.name)));
    for(const key of ['sku','barcode','taxable','inventoryPolicy'])check(`规格${i+1}.${key}`,v[key],a?.[key]);
    for(const key of ['price','compareAtPrice'])check(`规格${i+1}.${key}`,v[key]===undefined?undefined:Number(v[key]),a?.[key]===undefined?undefined:Number(a[key]));
    for(const key of ['tracked','requiresShipping','countryCodeOfOrigin','harmonizedSystemCode'])check(`规格${i+1}.${key}`,v.inventoryItem[key],a?.inventoryItem?.[key]);
    check(`规格${i+1}.成本`,v.inventoryItem.cost===undefined?undefined:Number(v.inventoryItem.cost),a?.inventoryItem?.unitCost?Number(a.inventoryItem.unitCost.amount):undefined);
    const weight=a?.inventoryItem?.measurement?.weight;const factor:Record<string,number>={KILOGRAMS:1,GRAMS:0.001,POUNDS:0.45359237,OUNCES:0.028349523125};
    check(`规格${i+1}.运输重量kg`,v.inventoryItem.measurement?.weight.value,weight?Math.round(weight.value*factor[weight.unit]*1e6)/1e6:undefined);
    for(const q of v.inventoryQuantities??[])check(`规格${i+1}.地点库存`,q.quantity,a?.inventoryItem.inventoryLevels.nodes.find((l:any)=>l.location.id===q.locationId)?.quantities.find((q:any)=>q.name==='available')?.quantity);
  }
  if(expected.files?.length){
    check('媒体数量',expected.files.length,actual.media.nodes.length);
    const expectedOrder=expected.files.map((f:any)=>f.alt),actualOrder=actual.media.nodes.map((m:any)=>m.alt);
    result.push({field:'商品媒体顺序',expected:expectedOrder,actual:actualOrder,status:JSON.stringify(expectedOrder)===JSON.stringify(actualOrder)?'MATCH':expected.mediaOrderPending?'PENDING':'MISMATCH'});
    const cover=actual.featuredMedia;
    result.push({field:'商品封面',expected:expectedOrder[0],actual:cover?.alt,status:cover?.alt===expectedOrder[0]?'MATCH':expected.mediaOrderPending||(!cover && actual.media.nodes.find((m:any)=>m.alt===expectedOrder[0])?.status!=='READY')?'PENDING':'MISMATCH'});
    for(const f of expected.files){
      const m=actual.media.nodes.find((m:any)=>m.alt===f.alt);
      if(f.contentType)check(`媒体类型 ${f.alt}`,f.contentType,m?.mediaContentType);
      result.push({field:`${f.contentType==='VIDEO'?'视频':'图片'} ${f.alt}`,status:m?.status==='READY'?'MATCH':m?.status==='FAILED'||!m?'MISMATCH':'PENDING',expected:'READY',actual:m?.status});
    }
  }

  return result;
}

export async function readIntegratedProduct(config:ShopifyDevConfig,token:string,id:string,quantities:boolean,fetchImpl:typeof fetch=fetch) {
    const inventory = quantities ? 'inventoryLevels(first:100){nodes{location{id} quantities(names:["available"]){name quantity}}}' : '';
    const query=`query($id:ID!){product(id:$id){id title descriptionHtml vendor productType tags status handle templateSuffix category{id} collections(first:100){nodes{id}} seo{title description} featuredMedia{id alt mediaContentType} media(first:100){nodes{id alt status mediaContentType}} variants(first:100){nodes{id sku barcode price compareAtPrice taxable inventoryPolicy selectedOptions{name value} inventoryItem{tracked requiresShipping countryCodeOfOrigin harmonizedSystemCode unitCost{amount} measurement{weight{value unit}} ${inventory}}}}}}`;
    const data=await shopifyGraphql<any>(config,token,query,{id},fetchImpl);
    if(!data.product)throw new Error('未返回商品');return data.product;
}

export async function reorderShopifyMedia(config:ShopifyDevConfig,token:string,id:string,files:any[],actual:any,fetchImpl:typeof fetch=fetch):Promise<string|null> {
 if(!files.length)return null;
 const ordered=files.map(f=>actual.media.nodes.find((m:any)=>m.alt===f.alt));
 if(ordered.some(m=>!m))return null; // Missing media is reported by readback, never guessed.
 if(ordered.every((m,i)=>m.id===actual.media.nodes[i]?.id))return null;
 const d=await shopifyGraphql<any>(config,token,`mutation($id:ID!,$moves:[MoveInput!]!){productReorderMedia(id:$id,moves:$moves){job{id} mediaUserErrors{field message}}}`,{id,moves:ordered.map((m,i)=>({id:m.id,newPosition:String(i)}))},fetchImpl);
 if(d.productReorderMedia.mediaUserErrors.length)throw new Error(d.productReorderMedia.mediaUserErrors.map((e:any)=>e.message).join('；'));
 if(!d.productReorderMedia.job?.id)throw new Error('Shopify 未返回媒体排序任务');return d.productReorderMedia.job.id;
}
export async function refreshMediaOrderStatus(config:ShopifyDevConfig,token:string,expected:Record<string,any>,fetchImpl:typeof fetch=fetch) {
 if(!expected.mediaOrderJobId)return expected;
 const d=await shopifyGraphql<any>(config,token,'query($id:ID!){job(id:$id){done}}',{id:expected.mediaOrderJobId},fetchImpl);
 return {...expected,mediaOrderPending:!d.job?.done};
}
