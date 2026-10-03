import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { getProductPassport } from '@/lib/server/passport-store';
import { localizedPublicationPayload } from '@/lib/agents/listing-localization';
import { loadAmazonUsConnection, missingAmazonUsConnection } from '@/lib/platforms/amazon-us-config';
import { previewAmazonListingAgainstLiveRules } from '@/lib/platforms/amazon-live-preview';

export const dynamic = 'force-dynamic';

async function handlePOST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const body = await request.json().catch(() => ({})) as { draftId?: unknown };
    if (typeof body.draftId !== 'string' || !body.draftId.trim()) return Response.json({ error: '请选择 Amazon Listing' }, { status: 400 });
    const bindings = getBindings();
    const missing = missingAmazonUsConnection(bindings);
    if (missing.length) return Response.json({ error: '尚未连接已授权的 Amazon 卖家账户；需要正式 SP-API 应用凭据、卖家授权令牌和卖家 ID。沙箱凭据不能用于真实字段校验。' }, { status: 503 });
    const passport = await getProductPassport(bindings.DB, taskId);
    const draft = passport?.platformDrafts.find((item) => item.id === body.draftId);
    if (!draft || draft.platformId !== 'amazon' || !isListingDraftPayload(draft.payload)) return Response.json({ error: '找不到 Amazon Listing 审核稿' }, { status: 404 });
    if (draft.status !== 'APPROVED' && draft.status !== 'DRAFT_CREATED') return Response.json({ error: '请先确认 Amazon Listing' }, { status: 409 });
    const result = await previewAmazonListingAgainstLiveRules(loadAmazonUsConnection(bindings), localizedPublicationPayload(draft.payload));
    return Response.json({ result });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Amazon 正式预校验失败' }, { status: 502 });
  }
}

export const POST = withAuthentication(handlePOST);
