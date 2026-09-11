import { getBindings } from '@/db/client';
import { fetchShopifyListingSchema } from '@/lib/platforms/shopify-schema';
import { loadShopifyDevConfig } from '@/lib/platforms/shopify-dev';
import type { PlatformId } from '@/lib/domain/platform';
import { platformRegistry } from '@/lib/platforms/registry';
import { resolveMockListingSchema } from '@/lib/mock-platforms/schemas';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ platformId: string }> }) {
  const { platformId: rawPlatformId } = await context.params;
  const profile = platformRegistry.find((platform) => platform.id === rawPlatformId);
  if (!profile) return Response.json({ error: 'Unknown platform' }, { status: 404 });
  const url = new URL(request.url);
  const market = url.searchParams.get('market')?.trim() || profile.regions[0] || 'Global';
  const categoryId = url.searchParams.get('categoryId');
  const categoryLabel = url.searchParams.get('categoryLabel');
  if (profile.id === 'shopify') {
    try {
      if (!url.searchParams.get('market')) return Response.json({ error: '请明确目标市场' }, { status: 400 });
      return Response.json({ provider: 'SHOPIFY_ADMIN_API', schema: await fetchShopifyListingSchema(loadShopifyDevConfig(getBindings()), { market, categoryLabel }) });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Shopify 字段读取失败' }, { status: 502 }); }
  }
  return Response.json({
    provider: 'SKUFlow Mock Platform Server',
    schema: resolveMockListingSchema({
      platformId: profile.id as PlatformId,
      market,
      categoryId,
      categoryLabel,
    }),
  });
}
