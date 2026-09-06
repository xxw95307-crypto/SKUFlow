import { ensureSchema, getBindings } from '@/db/client';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import type { ProductPassport } from '@/lib/domain/product-passport';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { getProductPassport } from '@/lib/server/passport-store';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const { DB } = getBindings();
    const passport = await getProductPassport(DB, taskId);
    if (!passport) return Response.json({ error: 'Task not found' }, { status: 404 });
    const publishable = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED' && isListingDraftPayload(draft.payload));
    if (publishable.length === 0) return Response.json({ error: '至少确认一个平台 Listing 后才能创建 Mock 草稿' }, { status: 409 });
    const now = new Date().toISOString();
    const results = publishable.map((draft) => ({
      draft,
      mockDraftId: `mock_${draft.platformId.replace(/-/g, '_')}_${crypto.randomUUID()}`,
    }));
    await DB.batch(results.map(({ draft, mockDraftId }) => {
      const payload: ListingDraftPayload = {
        ...(draft.payload as unknown as ListingDraftPayload),
        mockPublication: { draftId: mockDraftId, status: 'DRAFT_CREATED', createdAt: now },
      };
      return DB.prepare(
        `UPDATE platform_drafts SET status = 'DRAFT_CREATED', payload_json = ?, updated_at = ?
         WHERE id = ? AND task_id = ? AND status = 'APPROVED'`,
      ).bind(JSON.stringify(payload), now, draft.id, taskId);
    }));
    return Response.json({
      mode: 'MOCK',
      message: '模拟平台草稿创建成功，未发送至真实平台',
      results: results.map(({ draft, mockDraftId }) => ({ platformId: draft.platformId, market: draft.market, draftId: mockDraftId, status: 'DRAFT_CREATED' })),
      passport: await getProductPassport(DB, taskId) as ProductPassport,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to create mock platform drafts' }, { status: 500 });
  }
}
