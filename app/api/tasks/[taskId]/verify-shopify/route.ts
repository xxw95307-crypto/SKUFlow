import { withAuthentication } from '@/lib/server/auth';
import {ensureSchema,getBindings} from '@/db/client';
import {loadShopifyDevConfig,exchangeAccessToken} from '@/lib/platforms/shopify-dev';
import {readIntegratedProduct,compareIntegratedProduct,refreshMediaOrderStatus} from '@/lib/platforms/shopify-integrated';
import {getProductPassport} from '@/lib/server/passport-store';
import {isListingDraftPayload} from '@/lib/mock-platforms/listing-compiler';
async function handlePOST(_request:Request,context:{params:Promise<{taskId:string}>}) {
 try {await ensureSchema();const {taskId}=await context.params;const b=getBindings();const config=loadShopifyDevConfig(b),token=await exchangeAccessToken(config,fetch);const passport=await getProductPassport(b.DB,taskId);if(!passport)return Response.json({error:'Task not found'},{status:404});
 const results=[];
 for(const draft of passport.platformDrafts){if(!isListingDraftPayload(draft.payload))continue;const pub=draft.payload.testPublication;if(!pub?.submittedProduct)continue;
 const expected=await refreshMediaOrderStatus(config,token,pub.submittedProduct);
 const actual=await readIntegratedProduct(config,token,pub.productId,pub.submittedProduct.variants.some((v:any)=>v.inventoryQuantities?.length));const verification=compareIntegratedProduct(expected,actual);
 const payload={...draft.payload,testPublication:{...pub,submittedProduct:expected,verification}};await b.DB.prepare('UPDATE platform_drafts SET payload_json=? WHERE id=? AND task_id=?').bind(JSON.stringify(payload),draft.id,taskId).run();results.push({market:draft.market,verification});}
 return Response.json({results,passport:await getProductPassport(b.DB,taskId)});
 }catch(e){return Response.json({error:(e as Error).message},{status:502});}
}

export const POST = withAuthentication(handlePOST);
