import { normalizeSaleVariants } from '@/lib/domain/shopify-validation';
import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import type { ListingFieldDefinition } from '@/lib/domain/listing';
import type { ProductPassport } from '@/lib/domain/product-passport';
import {
  confirmedInferredFields,
  isListingDraftPayload,
  listingFieldSources,
  validateMockListing,
} from '@/lib/mock-platforms/listing-compiler';
import { getProductPassport } from '@/lib/server/passport-store';

export const dynamic = 'force-dynamic';

function normalizeFieldValue(field: ListingFieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  if (field.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (field.type === 'variants') return normalizeSaleVariants(value);
  if (field.type === 'number') {
    const number = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(number) ? number : value;
  }
  if (field.type === 'string_array') {
    const items = Array.isArray(value) ? value : String(value).split('\n');
    return items.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, field.maxItems ?? 20);
  }
  return String(value).trim().slice(0, 8_000);
}

async function handlePATCH(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const body = await request.json() as {
      draftId?: unknown;
      action?: unknown;
      fields?: unknown;
      confirmedInferredFields?: unknown;
    };
    const draftId = typeof body.draftId === 'string' ? body.draftId : '';
    const action = body.action === 'approve' ? 'approve' : 'save';
    if (!draftId || !body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) {
      return Response.json({ error: 'Listing 草稿更新格式无效' }, { status: 400 });
    }
    const { DB } = getBindings();
    const passport = await getProductPassport(DB, taskId);
    if (!passport) return Response.json({ error: 'Task not found' }, { status: 404 });
    const draft = passport.platformDrafts.find((item) => item.id === draftId);
    if (!draft) return Response.json({ error: 'Listing draft not found' }, { status: 404 });
    if (draft.status === 'DRAFT_CREATED') return Response.json({error:'已发布草稿不可重新确认，请新建任务修改商品'},{status:409});
    if (!isListingDraftPayload(draft.payload)) return Response.json({ error: '请先生成该平台的 Listing' }, { status: 409 });

    const incoming = body.fields as Record<string, unknown>;
    const fieldSources = listingFieldSources(draft.payload);
    const fields: Record<string, unknown> = {};
    const fieldEvidence = {...draft.payload.fieldEvidence};
    const fieldNotes = {...draft.payload.fieldNotes};
    for (const field of draft.payload.schema.fields) {
      const actualSource = fieldSources[field.key] ?? field.source;
      const value = normalizeFieldValue(
        field,
        actualSource === 'PRODUCT_FACT' && !fieldEvidence[field.key] ? draft.payload.fields[field.key] : incoming[field.key],
      );
      if (value !== undefined) fields[field.key] = value;
      if (JSON.stringify(value) !== JSON.stringify(normalizeFieldValue(field,draft.payload.fields[field.key]))) {
        fieldSources[field.key] = 'SELLER_INPUT';
        delete fieldEvidence[field.key];
        delete fieldNotes[field.key];
      }
    }
    const requestedConfirmations = Array.isArray(body.confirmedInferredFields)
      ? body.confirmedInferredFields.filter((key): key is string => typeof key === 'string' && fieldSources[key] === 'AI_INFERRED')
      : confirmedInferredFields(draft.payload);
    const issues = validateMockListing(draft.payload.schema, fields, fieldSources, requestedConfirmations);
    const hasErrors = issues.some((issue) => issue.severity === 'error');
    const payload = { ...draft.payload, fields, fieldSources, fieldEvidence, fieldNotes, confirmedInferredFields: requestedConfirmations };
    delete payload.mockPublication;
    delete payload.localization;
    const status = action === 'approve' && !hasErrors ? 'APPROVED' : hasErrors ? 'NEEDS_REVIEW' : 'VALIDATED';
    const now = new Date().toISOString();
    await DB.prepare(
      `UPDATE platform_drafts
       SET status = ?, payload_json = ?, validation_json = ?, updated_at = ?
       WHERE id = ? AND task_id = ?`,
    ).bind(status, JSON.stringify(payload), JSON.stringify(issues), now, draftId, taskId).run();
    const refreshedPassport = await getProductPassport(DB, taskId) as ProductPassport;
    if (action === 'approve' && hasErrors) {
      return Response.json({ error: '已保存当前修改，请继续处理高亮字段', passport: refreshedPassport, issues, status }, { status: 409 });
    }
    return Response.json({ passport: refreshedPassport, issues, status });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to update listing draft' }, { status: 500 });
  }
}

export const PATCH = withAuthentication(handlePATCH);
