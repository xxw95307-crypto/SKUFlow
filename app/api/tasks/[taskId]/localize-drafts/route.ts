import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { callBailianListingLocalization } from '@/lib/ai/bailian-client';
import { loadBailianConfig, missingBailianConfig } from '@/lib/config/bailian';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import type { ProductPassport } from '@/lib/domain/product-passport';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { isChineseLocale, marketLocale } from '@/lib/localization/market-locales';
import { translatableListingFields } from '@/lib/agents/listing-localization';
import { getProductPassport } from '@/lib/server/passport-store';

export const dynamic = 'force-dynamic';

async function handlePOST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const body = await request.json().catch(() => ({})) as { draftId?: unknown };
    if (body.draftId !== undefined && typeof body.draftId !== 'string') return Response.json({ error: 'Listing 草稿 ID 格式无效' }, { status: 400 });
    await ensureSchema();
    const { taskId } = await context.params;
    const bindings = getBindings();
    const passport = await getProductPassport(bindings.DB, taskId);
    if (!passport) return Response.json({ error: 'Task not found' }, { status: 404 });
    const drafts = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED' && isListingDraftPayload(draft.payload)
      && (body.draftId === undefined || draft.id === body.draftId));
    if (!drafts.length) return Response.json({ error: '没有等待发布的已确认 Listing' }, { status: 409 });
    const requiresModel = drafts.some((draft) => !isChineseLocale(marketLocale(draft.market).locale));
    const config = loadBailianConfig(bindings);
    if (requiresModel) {
      const missing = missingBailianConfig(config);
      if (missing.length) return Response.json({ error: `百炼运行时配置不完整：${missing.join(', ')}` }, { status: 503 });
    }
    const summaries: Array<{ draftId: string; market: string; targetLocale: string; targetLanguage: string; translatedFields: number }> = [];
    for (const draft of drafts) {
      const payload = draft.payload as ListingDraftPayload;
      const target = marketLocale(draft.market);
      const reusable = payload.localization?.status === 'READY' && payload.localization.targetLocale === target.locale;
      let localization = payload.localization;
      if (!reusable) {
        if (isChineseLocale(target.locale)) {
          const keys = translatableListingFields(payload).map((field) => field.key);
          localization = {
            status: 'READY' as const,
            sourceLocale: 'zh-CN' as const,
            targetLocale: target.locale,
            targetLanguage: target.language,
            fields: Object.fromEntries(keys.flatMap((key) => key in payload.fields ? [[key, payload.fields[key]]] : [])),
            model: '无需翻译',
            requestId: null,
            createdAt: new Date().toISOString(),
          };
        } else {
          const response = await callBailianListingLocalization(config, { payload, targetLocale: target.locale, targetLanguage: target.language });
          localization = {
            status: 'READY' as const,
            sourceLocale: 'zh-CN' as const,
            targetLocale: target.locale,
            targetLanguage: target.language,
            fields: response.fields,
            model: response.model,
            requestId: response.requestId,
            createdAt: new Date().toISOString(),
          };
        }
      }
      const nextPayload: ListingDraftPayload = { ...payload, schema: { ...payload.schema, locale: target.locale }, localization };
      await bindings.DB.prepare('UPDATE platform_drafts SET payload_json = ?, updated_at = ? WHERE id = ? AND task_id = ? AND status = ?')
        .bind(JSON.stringify(nextPayload), new Date().toISOString(), draft.id, taskId, 'APPROVED').run();
      summaries.push({ draftId: draft.id, market: draft.market, targetLocale: target.locale, targetLanguage: target.language, translatedFields: Object.keys(localization.fields).length });
    }
    return Response.json({ passport: await getProductPassport(bindings.DB, taskId) as ProductPassport, localizations: summaries });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Listing 本地化失败';
    return Response.json({ error: message }, { status: /百炼|本地化|翻译/.test(message) ? 502 : 500 });
  }
}

export const POST = withAuthentication(handlePOST);
