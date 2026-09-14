import { withAuthentication } from '@/lib/server/auth';
import {getSelectedMedia} from '@/lib/server/media-candidates';
import {parseMediaOrderPlan,sameMediaSelection} from '@/lib/agents/media-ordering';
import { publishIntegratedShopify, type ShopifyMediaInput } from '@/lib/platforms/shopify-integrated';
import { fetchShopifyListingSchema } from '@/lib/platforms/shopify-schema';
import { ensureSchema, getBindings } from '@/db/client';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import type { ProductPassport } from '@/lib/domain/product-passport';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { loadShopifyDevConfig, publishShopifyDevDraft } from '@/lib/platforms/shopify-dev';
import { getProductPassport } from '@/lib/server/passport-store';

export const dynamic = 'force-dynamic';

interface DeliveryResult {
  platformId: string;
  market: string;
  draftId: string;
  status: 'DRAFT_CREATED';
  mode: 'SHOPIFY_DEV' | 'MOCK';
  adminUrl?: string | null;
  warnings?: string[];
  verification?: Array<{ field: string; status: string; expected?: unknown; actual?: unknown }>;
}

async function saveCreatedDraft(DB: D1Database, input: {
  taskId: string;
  draftId: string;
  payload: ListingDraftPayload;
  now: string;
}): Promise<void> {
  await DB.prepare(
    `UPDATE platform_drafts SET status = 'DRAFT_CREATED', payload_json = ?, updated_at = ?
     WHERE id = ? AND task_id = ? AND status = 'APPROVED'`,
  ).bind(JSON.stringify(input.payload), input.now, input.draftId, input.taskId).run();
}

async function handlePOST(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const bindings = getBindings();
    const { DB } = bindings;
    const body = await _request.json().catch(()=>({})) as {selectedAssetIds?:unknown;mediaPlanId?:string};
    const selectedIds: string[] = Array.isArray(body.selectedAssetIds) ? [...new Set(body.selectedAssetIds.filter((id:unknown):id is string=>typeof id==='string'))] : [];
    if(selectedIds.length>20) return Response.json({error:'单次最多选择 20 项媒体'},{status:400});
    const media: ShopifyMediaInput[] = [];
    const passport = await getProductPassport(DB, taskId);
    if (!passport) return Response.json({ error: 'Task not found' }, { status: 404 });
    const publishable = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED' && isListingDraftPayload(draft.payload));
    if (publishable.length === 0) return Response.json({ error: '至少确认一个平台 Listing 后才能创建测试草稿' }, { status: 409 });

    const hasShopify = publishable.some((draft) => draft.platformId === 'shopify');
    if(hasShopify) {
      const row=await DB.prepare("SELECT plan_json FROM media_order_plans WHERE task_id=? AND id=? AND status='CONFIRMED'").bind(taskId,body.mediaPlanId??'').first<{plan_json:string}>();
      if(!row)throw new Error('请先在对话中确认封面和媒体顺序，再发布');
      const latest=await DB.prepare('SELECT id FROM media_order_plans WHERE task_id=? ORDER BY created_at DESC LIMIT 1').bind(taskId).first<{id:string}>();
      if(latest?.id!==body.mediaPlanId)throw new Error('媒体编排已有新版，请确认最新版');
      const candidates=await getSelectedMedia(DB,taskId,selectedIds);
      const plan=parseMediaOrderPlan(JSON.parse(row.plan_json),candidates);
      if(!sameMediaSelection(plan,selectedIds))throw new Error('选中的媒体已改变，请重新编排并确认');
      for(const item of plan.items) {
        const c=candidates.find(c=>c.id===item.id)!;
        const object=await bindings.UPLOADS.get(c.objectKey);if(!object)throw new Error('找不到选中的媒体文件');
        media.push({name:`${c.id}.${c.type==='VIDEO'?(c.contentType==='video/webm'?'webm':'mp4'):'png'}`,contentType:c.contentType,bytes:await object.arrayBuffer(),alt:`${item.alt} · ${c.id}`});
      }
    }
    const shopifyConfig = hasShopify ? loadShopifyDevConfig(bindings) : null;
    const results: DeliveryResult[] = [];

    for (const draft of publishable) {
      const now = new Date().toISOString();
      const currentPayload = draft.payload as unknown as ListingDraftPayload;
      if (draft.platformId === 'shopify' && shopifyConfig) {
        if (!media.length) throw new Error('请选择要同步到 Shopify 的商品图片');
        const liveSchema = await fetchShopifyListingSchema(shopifyConfig, { market: draft.market });
        if (currentPayload.schema.mode !== 'SHOPIFY_API') throw new Error('这份 Shopify 审核稿使用旧版 Mock 字段，请重新生成并确认实际接口审核稿后发布。');
        const supported = new Set(liveSchema.fields.map((field) => field.key));
        if (currentPayload.schema.fields.some((field) => !supported.has(field.key))) throw new Error('Shopify 可写字段已发生变化，请重新生成审核稿。');
        const publication = await publishIntegratedShopify({
          config: shopifyConfig,
          payload: currentPayload,
          draftId: draft.id,
          media,
          onCreated: async(productId) => { await DB.prepare('UPDATE platform_drafts SET payload_json=? WHERE id=? AND task_id=?').bind(JSON.stringify({...currentPayload, pendingShopifyProductId:productId}),draft.id,taskId).run(); },
        });
        const payload: ListingDraftPayload = { ...currentPayload, testPublication: publication };
        await saveCreatedDraft(DB, { taskId, draftId: draft.id, payload, now });
        results.push({
          platformId: draft.platformId,
          market: draft.market,
          draftId: publication.productId,
          status: 'DRAFT_CREATED',
          mode: 'SHOPIFY_DEV',
          adminUrl: publication.adminUrl,
          warnings: publication.warnings,
          verification: publication.verification,
        });
        continue;
      }

      const mockDraftId = `mock_${draft.platformId.replace(/-/g, '_')}_${crypto.randomUUID()}`;
      const payload: ListingDraftPayload = {
        ...currentPayload,
        mockPublication: { draftId: mockDraftId, status: 'DRAFT_CREATED', createdAt: now },
      };
      await saveCreatedDraft(DB, { taskId, draftId: draft.id, payload, now });
      results.push({ platformId: draft.platformId, market: draft.market, draftId: mockDraftId, status: 'DRAFT_CREATED', mode: 'MOCK' });
    }

    const realCount = results.filter((item) => item.mode === 'SHOPIFY_DEV').length;
    const mockCount = results.length - realCount;
    return Response.json({
      mode: realCount ? (mockCount ? 'MIXED' : 'SHOPIFY_DEV') : 'MOCK',
      message: [
        realCount ? `${realCount} 个 Shopify Dev Store 未发布草稿已创建` : '',
        mockCount ? `${mockCount} 个其他平台本地 Mock 草稿已创建` : '',
      ].filter(Boolean).join('；'),
      results,
      passport: await getProductPassport(DB, taskId) as ProductPassport,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create platform test drafts';
    return Response.json({ error: message }, { status: message.includes('尚未配置') ? 503 : 500 });
  }
}

export const POST = withAuthentication(handlePOST);
