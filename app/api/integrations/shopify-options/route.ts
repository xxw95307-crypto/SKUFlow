import { withAuthentication } from '@/lib/server/auth';
import { getBindings } from '@/db/client';
import { loadShopifyDevConfig } from '@/lib/platforms/shopify-dev';
import { shopifyLookup } from '@/lib/platforms/shopify-integrated';
async function handleGET(request: Request) {
  try { const url=new URL(request.url); return Response.json({options:await shopifyLookup(loadShopifyDevConfig(getBindings()),url.searchParams.get('kind')||'',url.searchParams.get('q')||'')}); }
  catch(e) { return Response.json({error:(e as Error).message},{status:502}); }
}

export const GET = withAuthentication(handleGET);
