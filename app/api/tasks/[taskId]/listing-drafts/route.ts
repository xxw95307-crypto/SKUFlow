import { ensureSchema, getBindings } from '@/db/client';
import type { ListingFieldDefinition } from '@/lib/domain/listing';
import type { ProductPassport } from '@/lib/domain/product-passport';
import { isListingDraftPayload, validateMockListing } from '@/lib/mock-platforms/listing-compiler';
import { getProductPassport } from '@/lib/server/passport-store';

export const dynamic = 'force-dynamic';

function normalizeFieldValue(field: ListingFieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;
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

export async function PATCH(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const body = await request.json() as { draftId?: unknown; action?: unknown; fields?: unknown };
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
    if (!isListingDraftPayload(draft.payload)) return Response.json({ error: '请先生成该平台的 Listing' }, { status: 409 });

    const incoming = body.fields as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const field of draft.payload.schema.fields) {
      const value = normalizeFieldValue(
        field,
        field.source === 'PRODUCT_FACT' ? draft.payload.fields[field.key] : incoming[field.key],
      );
      if (value !== undefined) fields[field.key] = value;
    }
    const issues = validateMockListing(draft.payload.schema, fields);
    if (action === 'approve' && issues.some((issue) => issue.severity === 'error')) {
      return Response.json({ error: '请先补齐必填字段并修正校验问题', issues }, { status: 409 });
    }
    const payload = { ...draft.payload, fields };
    delete payload.mockPublication;
    const status = action === 'approve' ? 'APPROVED' : issues.some((issue) => issue.severity === 'error') ? 'NEEDS_REVIEW' : 'VALIDATED';
    const now = new Date().toISOString();
    await DB.prepare(
      `UPDATE platform_drafts
       SET status = ?, payload_json = ?, validation_json = ?, updated_at = ?
       WHERE id = ? AND task_id = ?`,
    ).bind(status, JSON.stringify(payload), JSON.stringify(issues), now, draftId, taskId).run();
    return Response.json({ passport: await getProductPassport(DB, taskId) as ProductPassport, issues, status });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to update listing draft' }, { status: 500 });
  }
}
