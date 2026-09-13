import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSuppliedFields, sellerFieldLabel, listingRequirement } from '../lib/agents/listing-evidence.ts';
import { parseListingGenerationOutput } from '../lib/agents/listing-generation.ts';
import { compileMockListingDraft } from '../lib/mock-platforms/listing-compiler.ts';
import { createInitialProductPassport } from '../lib/domain/product-passport.ts';
import type { ListingFieldDefinition, MockListingSchema } from '../lib/domain/listing.ts';

const fields: ListingFieldDefinition[] = [
  {key:'variant_price',label:'售价',type:'number',source:'SELLER_INPUT',required:false,unit:'USD'},
  {key:'variant_sku',label:'SKU',type:'string',source:'SELLER_INPUT',required:false},
  {key:'inventory_quantity',label:'库存',type:'number',source:'SELLER_INPUT',required:false},
  {key:'taxable',label:'是否收税',type:'boolean',source:'SELLER_INPUT',required:true},
];
const sources = [{id:'sheet',label:'商品表.xlsx',kind:'DOCUMENT' as const,text:'SKU：PINK-M；售价：19.9 USD；库存：0'}, {id:'chat',label:'卖家对话',kind:'USER_INPUT' as const,text:'不收税'}];
const supplied = {variant_sku:{value:'PINK-M',sourceId:'sheet',quote:'SKU：PINK-M'},variant_price:{value:19.9,sourceId:'sheet',quote:'售价：19.9 USD'},inventory_quantity:{value:0,sourceId:'sheet',quote:'库存：0'},taxable:{value:false,sourceId:'chat',quote:'不收税'}};

test('document SKU price zero inventory and explicit false from conversation retain evidence',()=>{
 const r=parseSuppliedFields(supplied,fields,sources);
 assert.equal(r.suppliedFields?.variant_price.value,19.9);
 assert.equal(r.suppliedFields?.inventory_quantity.value,0);
 assert.equal(r.suppliedFields?.taxable.value,false);
 assert.equal(r.suppliedFields?.taxable.evidence.sourceKind,'USER_INPUT');
});
test('model array output is normalized without dropping supplied values or accepting duplicates',()=>{
 const r=parseSuppliedFields(Object.entries(supplied).map(([key,v])=>({key,...v})),fields,sources);
 assert.equal(r.suppliedFields?.variant_price.value,19.9);
 const duplicate={key:'variant_sku',...supplied.variant_sku};
 assert.equal(parseSuppliedFields([duplicate,duplicate],fields,sources).suppliedFields?.variant_sku,undefined);
});
test('opposite boolean choices in one sentence are evaluated for their own field',()=>{
 const evidence=[{id:'u',label:'对话',kind:'USER_INPUT' as const,text:'不收税，需要运输。'}];
 const definitions=[fields[3],{key:'requires_shipping',label:'是否运输',type:'boolean',source:'SELLER_INPUT',required:true} as ListingFieldDefinition];
 const bind=(value:boolean)=>({value,sourceId:'u',quote:evidence[0].text});
 const r=parseSuppliedFields({taxable:bind(false),requires_shipping:bind(true)},definitions,evidence);
 assert.equal(r.suppliedFields?.taxable.value,false);assert.equal(r.suppliedFields?.requires_shipping.value,true);
 assert.equal(parseSuppliedFields({requires_shipping:bind(false)},definitions,evidence).suppliedFields?.requires_shipping,undefined);
});
test('fabricated citation, value and missing currency are never auto-filled',()=>{
 assert.equal(Object.keys(parseSuppliedFields({variant_sku:{value:'FAKE',sourceId:'sheet',quote:'SKU：PINK-M'}},fields,sources).suppliedFields!).length,0);
 assert.equal(Object.keys(parseSuppliedFields({variant_sku:{value:'FAKE',sourceId:'sheet',quote:'SKU：FAKE'}},fields,sources).suppliedFields!).length,0);
 const r=parseSuppliedFields({variant_price:{value:19.9,sourceId:'sheet',quote:'售价：19.9'}},fields,sources);
 assert.equal(r.suppliedFields?.variant_price,undefined);assert.match(r.fieldNotes!.variant_price,/币种/);
});
test('ambiguous values remain a request for clarification instead of a guessed value',()=>{
 const r=parseSuppliedFields({variant_price:{reason:'资料只有成本，没有明确售价',value:19.9}},fields,sources);
 assert.equal(r.suppliedFields?.variant_price,undefined);assert.match(r.fieldNotes!.variant_price,/成本/);
 const cost=[{id:'e',label:'表格',kind:'DOCUMENT' as const,text:'成本：8 USD'}];
 assert.equal(parseSuppliedFields({variant_price:{value:8,sourceId:'e',quote:cost[0].text}},fields,cost).suppliedFields?.variant_price,undefined);
});
test('lookup requires a real uniquely named option; duplicate warehouse names are not resolved arbitrarily',()=>{
 const f:ListingFieldDefinition={key:'location',label:'地点',type:'string',source:'SELLER_INPUT',required:false,lookup:'locations',options:[{value:'gid://1',label:'仓库A'}]};
 const evidence=[{id:'chat',label:'对话',kind:'USER_INPUT' as const,text:'库存放在仓库A'}];
 const binding={location:{sourceId:'chat',quote:'库存放在仓库A',value:'gid://1'}};
 assert.equal(parseSuppliedFields(binding,[f],evidence).suppliedFields?.location.value,'gid://1');
 f.options!.push({value:'gid://2',label:'仓库A'});
 assert.equal(parseSuppliedFields(binding,[f],evidence).suppliedFields?.location,undefined);
});
test('labels distinguish optional empty, required empty and valid zero/false',()=>{
 assert.equal(sellerFieldLabel('',false),'可选，未设置');assert.equal(sellerFieldLabel('',true),'需要卖家补充');
 assert.equal(sellerFieldLabel(0,true),'卖家已填写');assert.equal(sellerFieldLabel(false,true),'卖家已填写');
 assert.equal(listingRequirement(fields[0],{}),true);
 assert.equal(listingRequirement(fields[0],{variants:[{sku:'M'}]}),false);
});
test('generation and compilation use supplied evidence, keep seller edits on regeneration',()=>{
 const schema={mode:'MOCK',platformId:'shopify',fields} as MockListingSchema;
 const generated=parseListingGenerationOutput(JSON.stringify({drafts:[{draftId:'d',fields:{variant_price:999},suppliedFields:supplied}]}),{productName:'T恤',facts:[],drafts:[{draftId:'d',schema}],evidenceSources:sources}).drafts[0];
 assert.equal(generated.fields.variant_price,undefined);
 const passport=createInitialProductPassport({taskId:'t',platforms:['shopify'],markets:['美国'],now:'2026-09-13',idFactory:()=> 'id'});
 const input={passport,draft:passport.platformDrafts[0],schema,generatedFields:generated.fields,suppliedFields:generated.suppliedFields};
 const result=compileMockListingDraft(input);
 assert.equal(result.payload.fields.variant_sku,'PINK-M');assert.equal(result.payload.fieldSources.variant_sku,'PRODUCT_FACT');
 result.payload.fields.variant_price=25;result.payload.fieldSources.variant_price='SELLER_INPUT';
 assert.equal(compileMockListingDraft({...input,existingPayload:result.payload}).payload.fields.variant_price,25);
});
