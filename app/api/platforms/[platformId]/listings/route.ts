import { withAuthentication } from '@/lib/server/auth';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import { platformRegistry } from '@/lib/platforms/registry';
import {
  confirmedInferredFields,
  isListingDraftPayload,
  listingFieldSources,
  validateMockListing,
} from '@/lib/mock-platforms/listing-compiler';

export const dynamic = 'force-dynamic';

async function handlePOST(request: Request, context: { params: Promise<{ platformId: string }> }) {
  try {
    const { platformId } = await context.params;
    if (!platformRegistry.some((platform) => platform.id === platformId)) {
      return Response.json({ error: 'Unknown platform' }, { status: 404 });
    }
    const body = await request.json() as { action?: unknown; listing?: unknown };
    if (!isListingDraftPayload(body.listing)) return Response.json({ error: 'listing 格式无效' }, { status: 400 });
    const listing = body.listing as ListingDraftPayload;
    if (listing.schema.platformId !== platformId) return Response.json({ error: '平台与 Listing Schema 不一致' }, { status: 400 });
    const issues = validateMockListing(
      listing.schema,
      listing.fields,
      listingFieldSources(listing),
      confirmedInferredFields(listing),
    );
    if (body.action === 'validate') return Response.json({ mode: 'MOCK', valid: !issues.some((issue) => issue.severity === 'error'), issues });
    if (body.action !== 'create_draft') return Response.json({ error: 'action must be validate or create_draft' }, { status: 400 });
    if (issues.some((issue) => issue.severity === 'error')) {
      return Response.json({ error: 'Listing 仍有必填字段或校验问题', issues }, { status: 409 });
    }
    return Response.json({
      mode: 'MOCK',
      draftId: `mock_${platformId.replace(/-/g, '_')}_${crypto.randomUUID()}`,
      status: 'DRAFT_CREATED',
      message: '模拟平台草稿创建成功，未发送至真实平台',
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Mock Listing request failed' }, { status: 500 });
  }
}

export const POST = withAuthentication(handlePOST);
