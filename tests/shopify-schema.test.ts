import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchShopifyListingSchema } from '../lib/platforms/shopify-schema.ts';
import { publishShopifyDevDraft } from '../lib/platforms/shopify-dev.ts';
const config = { storeDomain: 'test.myshopify.com', clientId: 'id', clientSecret: 'secret', apiVersion: '2026-07' };
test('live schema includes only returned API fields and uses shop currency without mock fallback', async () => {
  const mock: typeof fetch = async (url) => String(url).includes('access_token') ? Response.json({access_token:'x'}) : Response.json({data: Object.fromEntries([
    ['shop', {currencyCode:'JPY'}], ...['ProductCreateInput','SEOInput','ProductVariantsBulkInput','InventoryItemInput','ProductSetInput','ProductVariantSetInput','ProductSetInventoryInput','FileSetInput','WeightInput'].map(name => [name,{inputFields:[{name: name === 'ProductVariantsBulkInput' ? 'price' : name === 'InventoryItemInput' ? 'sku' : 'title',description:'',type:{kind:'SCALAR',name:'String'}}]}])
  ])});
  const schema = await fetchShopifyListingSchema(config,{market:'日本'},mock);
  assert.equal(schema.mode,'SHOPIFY_API');
  assert.equal(schema.fields.find(f=>f.key==='variant_price')?.unit,'JPY');
  assert.equal(schema.fields.some(f=>f.key==='body_html'),false);
  await assert.rejects(()=>fetchShopifyListingSchema(config,{market:'日本'},async()=>Response.json({error:'denied'},{status:403})));
});
for (const failRead of [false,true]) test(`readback ${failRead ? 'failure preserves created draft' : 'detects value mismatch'}`,async()=>{
  const mock: typeof fetch = async(url,init)=>{
    if(String(url).includes('access_token')) return Response.json({access_token:'x'});
    const {query} = JSON.parse(String(init?.body));
    if(query.includes('CreateSkuFlowProduct')) return Response.json({data:{productCreate:{product:{id:'gid://shopify/Product/1',handle:'test',status:'DRAFT',variants:{nodes:[]}},userErrors:[]}}});
    if(failRead) return Response.json({}, {status:503});
    return Response.json({data:{product:{title:'different',status:'DRAFT',tags:[],variants:{nodes:[]}}}});
  };
  const result = await publishShopifyDevDraft({config,draftId:'test',payload:{fields:{title:'expected'}} as any},mock);
  assert.equal(result.productId,'gid://shopify/Product/1');
  assert.ok(result.verification?.some(f=>f.status===(failRead?'UNVERIFIED':'MISMATCH')));
});
