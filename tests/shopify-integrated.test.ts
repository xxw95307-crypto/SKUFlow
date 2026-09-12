import assert from 'node:assert/strict';
import test from 'node:test';
import {buildIntegratedProduct,validateShopifyFields,publishIntegratedShopify,compareIntegratedProduct} from '../lib/platforms/shopify-integrated.ts';
const fields={title:'test',taxable:false,requires_shipping:true,inventory_tracked:true,inventory_location:'gid://shopify/Location/1',variants:[{options:'Color=Pink;Size=M',sku:'M',price:2,quantity:0,weight:0.28},{options:'Color=Pink;Size=L',sku:'L',price:3,quantity:4,weight:0.3}]};
test('integrated payload maps per-variant inventory, weight and explicit choices without cross products',()=>{
 const p=buildIntegratedProduct({fields} as any,'draft');const v=p.variants as any[];assert.equal(v.length,2);assert.equal(v[0].inventoryQuantities[0].quantity,0);assert.equal(v[1].inventoryQuantities[0].quantity,4);assert.equal(v[0].inventoryItem.measurement.weight.unit,'KILOGRAMS');assert.equal(p.status,'DRAFT');assert.equal(v[0].taxable,false);
});
test('missing operational data and inconsistent variant dimensions block approval',()=>{
 assert.ok(validateShopifyFields({...fields,inventory_location:''}).length);
 assert.ok(validateShopifyFields({...fields,variants:[{options:'Size=M',sku:'M',price:'',quantity:-1}]}).length);
 assert.ok(validateShopifyFields({...fields,variants:[...fields.variants,{options:'Color=Red',sku:'R',price:1,quantity:1,weight:1}]}).some(e=>e.includes('相同')));
});
test('missing inventory permission blocks before any product mutation',async()=>{
 let mutated=false;await assert.rejects(()=>publishIntegratedShopify({config:{storeDomain:'test.myshopify.com',clientId:'x',clientSecret:'y',apiVersion:'2026-07'},payload:{fields} as any,draftId:'test',media:[]},async(url,init)=>{
 if(String(url).includes('access_token'))return Response.json({access_token:'x'});const q=JSON.parse(String(init?.body)).query;if(q.includes('mutation'))mutated=true;return Response.json({data:{currentAppInstallation:{accessScopes:[{handle:'write_products'}]}}});}),/write_inventory/);assert.equal(mutated,false);
});
test('readback matches variants by selected options and detects location-level inventory mismatch',()=>{
 const p=buildIntegratedProduct({fields} as any,'test');const actual={title:p.title,status:'DRAFT',tags:p.tags,collections:{nodes:[]},variants:{nodes:(p.variants as any[]).map(v=>({...v,selectedOptions:v.optionValues.map((o:any)=>({name:o.optionName,value:o.name})),inventoryItem:{...v.inventoryItem,inventoryLevels:{nodes:[{location:{id:fields.inventory_location},quantities:[{name:'available',quantity:99}]}]}}})).reverse()},media:{nodes:[]}};
 const r=compareIntegratedProduct(p,actual);assert.equal(r.filter(v=>v.field.includes('地点库存')&&v.status==='MISMATCH').length,2);assert.ok(r.filter(v=>v.field.endsWith('.sku')).every(v=>v.status==='MATCH'));
});
