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
