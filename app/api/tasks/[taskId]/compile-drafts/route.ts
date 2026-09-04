import { ensureSchema, getBindings } from '@/db/client';
import { callBailianListingGeneration } from '@/lib/ai/bailian-client';
import { loadBailianConfig, missingBailianConfig } from '@/lib/config/bailian';
import type { DraftValidationIssue, ProductPassport } from '@/lib/domain/product-passport';
import { compileMockListingDraft, isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { resolveMockListingSchema } from '@/lib/mock-platforms/schemas';
import { getProductPassport, saveCompiledDrafts } from '@/lib/server/passport-store';

export const dynamic = 'force-dynamic';

interface DraftCompileSummary {
  draftId: string;
  platformId: string;
  market: string;
  adapterId: string;
  mappedFields: number;
  issues: DraftValidationIssue[];
  status: 'NEEDS_REVIEW' | 'VALIDATED';
}

export async function POST(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const bindings = getBindings();
    const config = loadBailianConfig(bindings);
    const missing = missingBailianConfig(config);
    if (missing.length > 0) return Response.json({ error: `百炼运行时配置不完整：${missing.join(', ')}` }, { status: 503 });

    const task = await bindings.DB.prepare('SELECT id, product_name FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<{ id: string; product_name: string }>();
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    const passport = await getProductPassport(bindings.DB, taskId);
    if (!passport) return Response.json({ error: 'Product passport not found' }, { status: 404 });
    if (passport.status === 'LOCKED') return Response.json({ error: 'Product passport is locked' }, { status: 409 });
    if (passport.conflicts.some((conflict) => conflict.status === 'OPEN')) {
      return Response.json({ error: '请先确认商品档案中的图文冲突，再生成平台 Listing' }, { status: 409 });
    }
    if (passport.platformDrafts.length === 0) return Response.json({ error: '当前任务没有平台草稿' }, { status: 409 });

    const categoryFact = passport.facts.find((fact) => fact.key === 'product.category_hint' && fact.value !== null);
    const categoryLabel = typeof categoryFact?.value === 'string' ? categoryFact.value : '通用商品';
    const productNameFact = passport.facts.find((fact) => fact.key === 'product.name' && fact.value !== null && fact.status !== 'CONFLICT');
    const productName = typeof productNameFact?.value === 'string' ? productNameFact.value : task.product_name;
    const targets = passport.platformDrafts.map((draft) => ({
      draftId: draft.id,
      schema: resolveMockListingSchema({
        platformId: draft.platformId,
        market: draft.market,
        categoryId: draft.categoryId,
        categoryLabel,
      }),
    }));
    const modelResponse = await callBailianListingGeneration(config, {
      productName,
      facts: passport.facts,
      drafts: targets,
    });
    const generatedByDraft = new Map(modelResponse.output.drafts.map((draft) => [draft.draftId, draft.fields]));

    const writes = [];
    const summaries: DraftCompileSummary[] = [];
    for (const draft of passport.platformDrafts) {
      const target = targets.find((item) => item.draftId === draft.id)!;
      const existingPayload = isListingDraftPayload(draft.payload) ? draft.payload : undefined;
      const result = compileMockListingDraft({
        passport,
        draft,
        schema: target.schema,
        generatedFields: generatedByDraft.get(draft.id),
        existingPayload,
      });
      const status = result.validationIssues.some((issue) => issue.severity === 'error') ? 'NEEDS_REVIEW' as const : 'VALIDATED' as const;
      writes.push({
        draftId: draft.id,
        status,
        schemaVersion: target.schema.schemaVersion,
        payload: result.payload as unknown as Record<string, unknown>,
        validationIssues: result.validationIssues,
      });
      summaries.push({
        draftId: draft.id,
        platformId: draft.platformId,
        market: draft.market,
        adapterId: `${draft.platformId}-mock-adapter`,
        mappedFields: result.mappedFields,
        issues: result.validationIssues,
        status,
      });
    }

    await saveCompiledDrafts(bindings.DB, passport.id, writes);
    const refreshedPassport = await getProductPassport(bindings.DB, taskId) as ProductPassport;
    return Response.json({
      passport: refreshedPassport,
      provider: { mode: 'MOCK_PLATFORM_API', model: modelResponse.model },
      summary: {
        compiledDrafts: summaries.length,
        validatedDrafts: summaries.filter((item) => item.status === 'VALIDATED').length,
        reviewDrafts: summaries.filter((item) => item.status === 'NEEDS_REVIEW').length,
        mappedFields: summaries.reduce((sum, item) => sum + item.mappedFields, 0),
        issueCount: summaries.reduce((sum, item) => sum + item.issues.length, 0),
        drafts: summaries,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to generate platform listings';
    return Response.json({ error: message }, { status: /百炼|Listing Agent/.test(message) ? 502 : 500 });
  }
}
