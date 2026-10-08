import { withAuthentication } from '@/lib/server/auth';
import { shopifyLookup } from '@/lib/platforms/shopify-integrated';
import { getParseResults } from '@/lib/server/parse-store';
import { buildFactExtractionContext } from '@/lib/agents/fact-extraction';
import type { ListingEvidenceSource } from '@/lib/agents/listing-evidence';
import { fetchShopifyListingSchema } from '@/lib/platforms/shopify-schema';
import { loadShopifyDevConfig } from '@/lib/platforms/shopify-dev';
import { ensureSchema, getBindings } from '@/db/client';
import { callBailianListingGeneration } from '@/lib/ai/bailian-client';
import { selectListingDraftBatch } from '@/lib/agents/listing-batch';
import { loadBailianConfig, missingBailianConfig } from '@/lib/config/bailian';
import type { DraftValidationIssue, ProductPassport } from '@/lib/domain/product-passport';
import { compileMockListingDraft, isListingDraftPayload, validateMockListing } from '@/lib/mock-platforms/listing-compiler';
import { resolveMockListingSchema } from '@/lib/mock-platforms/schemas';
import { suggestAmazonProductType } from '@/lib/platforms/amazon-us-sandbox';
import { getProductPassport, saveCompiledDrafts } from '@/lib/server/passport-store';
import { currentAccount } from '@/lib/server/auth';
import { getShopPreferences } from '@/lib/server/shop-preferences-store';
import { getScenePlan } from '@/lib/server/scene-plan-store';

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

async function handlePOST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const body = await request.json().catch(() => ({})) as {prefillOnly?:boolean;draftIds?:unknown};
    const prefillOnly = body?.prefillOnly === true;
    if (body.draftIds !== undefined && (!Array.isArray(body.draftIds) || body.draftIds.some((id) => typeof id !== 'string'))) {
      return Response.json({ error: 'Listing 草稿 ID 格式无效' }, { status: 400 });
    }
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
    const editableDrafts = selectListingDraftBatch(passport.platformDrafts, body.draftIds as string[] | undefined);
    if (!editableDrafts.length) return Response.json({error:'没有待生成的 Listing 草稿。'},{status:409});
    const scenePlan = await getScenePlan(bindings.DB, taskId);
    const targets = await Promise.all(editableDrafts.map(async (draft) => ({
      draftId: draft.id,
      scene: scenePlan?.scenes.find((scene) => scene.id === draft.sceneId) ?? null,
      schema: draft.platformId === 'shopify' ? await fetchShopifyListingSchema(loadShopifyDevConfig(bindings), { market: draft.market, categoryLabel }) : resolveMockListingSchema({
        platformId: draft.platformId,
        market: draft.market,
        categoryId: draft.categoryId,
        categoryLabel,
      }),
    })));
    const parsedSources = buildFactExtractionContext((await getParseResults(bindings.DB, taskId)).filter(r => r.status !== 'FAILED')).items;
    const evidenceSources: ListingEvidenceSource[] = parsedSources.map(item => ({id:item.ref,label:item.filename,kind:'DOCUMENT',text:item.excerpt}));
    const conversation = await bindings.DB.prepare('SELECT messages_json FROM agent_conversations WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1').bind(taskId).first<{messages_json:string}>();
    if (conversation) {
      const messages = JSON.parse(conversation.messages_json);
      for (const m of Array.isArray(messages) ? messages.slice(-60) : []) {
        if(m.role === 'user' && typeof m.text === 'string' && m.text.trim()) evidenceSources.push({id:`message:${m.id}`,label:'卖家对话',kind:'USER_INPUT',text:m.text.slice(0,8000)});
      }
    }
    for (const fact of passport.facts.filter(f => f.value !== null && !['MISSING','CONFLICT'].includes(f.status))) {
      evidenceSources.push({id:`fact:${fact.id}`,label:fact.label,kind:fact.sourceKind === 'USER_INPUT' ? 'USER_INPUT' : 'FACT',text:`${fact.label}: ${typeof fact.value === 'object' ? JSON.stringify(fact.value) : fact.value} ${fact.unit ?? ''}`});
    }
    for (const target of targets.filter(t => t.schema.mode === 'SHOPIFY_API')) {
      for (const field of target.schema.fields.filter(f => f.lookup)) {
        try { field.options = await shopifyLookup(loadShopifyDevConfig(bindings),field.lookup!,field.lookup === 'categories' ? categoryLabel : ''); }
        catch { field.options = []; } // Unavailable options must be selected later; never invent IDs.
      }
    }
    const modelResponse = await callBailianListingGeneration(config, {
      productName,
      facts: passport.facts,
      evidenceSources,
      preferences: await getShopPreferences(bindings.DB, (await currentAccount())!.id),
      drafts: prefillOnly ? targets.map(t => ({...t,schema:{...t.schema,fields:t.schema.fields.filter(f => f.source !== 'AI_GENERATED').map(f => ({...f,allowAiInference:false}))}})) : targets,
    });
    const generatedByDraft = new Map(modelResponse.output.drafts.map((draft) => [draft.draftId, draft]));

    const writes = [];
    const summaries: DraftCompileSummary[] = [];
    for (const draft of editableDrafts) {
      const target = targets.find((item) => item.draftId === draft.id)!;
      const existingPayload = isListingDraftPayload(draft.payload) ? draft.payload : undefined;
      const result = compileMockListingDraft({
        passport,
        draft,
        schema: target.schema,
        generatedFields: generatedByDraft.get(draft.id)?.fields,
        suppliedFields: generatedByDraft.get(draft.id)?.suppliedFields,
        fieldNotes: generatedByDraft.get(draft.id)?.fieldNotes,
        existingPayload,
      });
      if (draft.platformId === 'amazon' && !result.payload.fields.product_type_code) {
        const suggestion = suggestAmazonProductType(categoryLabel, productName);
        if (suggestion) {
          result.payload.fields.product_type_code = suggestion;
          result.payload.fieldSources.product_type_code = 'AI_INFERRED';
          result.validationIssues = validateMockListing(result.payload.schema, result.payload.fields, result.payload.fieldSources, result.payload.confirmedInferredFields);
          result.mappedFields += 1;
        }
      }
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
        adapterId: draft.platformId === 'shopify' ? 'shopify-admin-api' : `${draft.platformId}-mock-adapter`,
        mappedFields: result.mappedFields,
        issues: result.validationIssues,
        status,
      });
    }

    await saveCompiledDrafts(bindings.DB, passport.id, writes);
    const refreshedPassport = await getProductPassport(bindings.DB, taskId) as ProductPassport;
    return Response.json({
      passport: refreshedPassport,
      provider: { mode: targets.some(t=>t.schema.mode==='SHOPIFY_API') ? 'PLATFORM_API' : 'MOCK_PLATFORM_API', model: modelResponse.model },
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

export const POST = withAuthentication(handlePOST);
