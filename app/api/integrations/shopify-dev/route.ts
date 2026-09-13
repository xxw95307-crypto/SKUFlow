import { withAuthentication } from '@/lib/server/auth';
import { getBindings } from '@/db/client';
import { getShopifyDevStatus } from '@/lib/platforms/shopify-dev';

export const dynamic = 'force-dynamic';

async function handleGET() {
  try {
    return Response.json(getShopifyDevStatus(getBindings()));
  } catch (error) {
    return Response.json({
      provider: 'SHOPIFY_DEV',
      configured: false,
      error: error instanceof Error ? error.message : 'Shopify Dev Store 配置无效',
    }, { status: 500 });
  }
}

export const GET = withAuthentication(handleGET);
