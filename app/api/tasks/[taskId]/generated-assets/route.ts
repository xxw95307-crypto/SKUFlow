import { currentAccount, withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { ASSET_PLAN_VERSION, buildAssetGenerationPrompt } from '@/lib/agents/asset-generation';
import { callBailianAssetPlanning, callBailianVisualIntent } from '@/lib/ai/bailian-client';
import { loadBailianConfig, loadBailianImageConfig, missingBailianConfig, missingBailianImageConfig } from '@/lib/config/bailian';
import type { GeneratedAsset, GeneratedAssetSummary } from '@/lib/domain/generated-asset';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { listGeneratedAssetHistory, listLatestGeneratedAssets, prepareGeneratedAssetInsert } from '@/lib/server/generated-asset-store';
import { getProductPassport } from '@/lib/server/passport-store';
import { getTaskSnapshot } from '@/lib/server/task-store';
import { getShopPreferences } from '@/lib/server/shop-preferences-store';
import { getScenePlan, saveScenePlan } from '@/lib/server/scene-plan-store';
import { generateVerifiedImage } from '@/lib/server/verified-image';

export const dynamic = 'force-dynamic';

interface ImageFileRow {
  id: string;
  object_key: string;
  content_type: string;
}

function summarize(assets: readonly GeneratedAsset[]): GeneratedAssetSummary {
  return {
    total: assets.length,
    completed: assets.filter((asset) => asset.status === 'COMPLETED').length,
    failed: assets.filter((asset) => asset.status === 'FAILED').length,
  };
}

async function requestOptions(request: Request): Promise<{ force: boolean; guidance: string | null; count: number | null; style: string | null; notes: string | null; sceneCounts: Record<string, number> | null; confirmedBrief: boolean }> {
  const raw = await request.text();
  if (!raw.trim()) return { force: false, guidance: null, count: null, style: null, notes: null, sceneCounts: null, confirmedBrief: false };
  try {
    const value = JSON.parse(raw) as { force?: unknown; guidance?: unknown; count?: unknown; style?: unknown; notes?: unknown; sceneCounts?: unknown; confirmedBrief?: unknown };
    if (value.count != null && (!Number.isInteger(value.count) || (value.count as number) < 1 || (value.count as number) > 6)) {
      throw new Error('图片数量需为 1–6 张');
    }
    const guidance = typeof value.guidance === 'string' ? value.guidance.trim().slice(0, 500) : '';
    const style = typeof value.style === 'string' ? value.style.trim().slice(0, 200) : '';
    const notes = typeof value.notes === 'string' ? value.notes.trim().slice(0, 500) : '';
    const sceneCounts = value.sceneCounts && typeof value.sceneCounts === 'object' && !Array.isArray(value.sceneCounts) ? value.sceneCounts as Record<string, number> : null;
    if (sceneCounts && Object.values(sceneCounts).some((count) => !Number.isInteger(count) || count < 1 || count > 6)) throw new Error('每套场景需选择 1–6 张图片');
    return { force: value.force === true, guidance: guidance || null, count: value.count == null ? null : value.count as number, style: style || null, notes: notes || null, sceneCounts, confirmedBrief: value.confirmedBrief === true };
  } catch {
    throw new Error('图片生成参数无效，请检查张数');
  }
}

async function handleGET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const task = await getTaskSnapshot(getBindings().DB, taskId);
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    if (new URL(request.url).searchParams.get('history') === '1') {
      return Response.json({ batches: await listGeneratedAssetHistory(getBindings().DB, taskId) });
    }
    const assets = await listLatestGeneratedAssets(getBindings().DB, taskId);
    return Response.json({ assets, summary: summarize(assets) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '素材读取失败' }, { status: 500 });
  }
}

async function handlePOST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const options = await requestOptions(request);
    const bindings = getBindings();
    const config = loadBailianImageConfig(bindings);
    const planningConfig = loadBailianConfig(bindings);
    const missing = [...new Set([...missingBailianImageConfig(config), ...missingBailianConfig(planningConfig)])];
    if (missing.length > 0) return Response.json({ error: `百炼素材生成配置不完整：${missing.join(', ')}` }, { status: 503 });

    const [task, passport, existing] = await Promise.all([
      getTaskSnapshot(bindings.DB, taskId),
      getProductPassport(bindings.DB, taskId),
      listLatestGeneratedAssets(bindings.DB, taskId),
    ]);
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    if (!passport) return Response.json({ error: 'Product passport not found' }, { status: 404 });
    let scenePlan = await getScenePlan(bindings.DB, taskId);
    if (options.confirmedBrief && options.sceneCounts) {
      if (!scenePlan || scenePlan.mode !== 'SPLIT' || Object.keys(options.sceneCounts).length !== scenePlan.scenes.length
        || scenePlan.scenes.some((scene) => !Number.isInteger(options.sceneCounts?.[scene.id]))) throw new Error('场景图片数量与当前场景方案不匹配');
      scenePlan = { ...scenePlan, scenes: scenePlan.scenes.map((scene) => ({ ...scene, imageCount: options.sceneCounts![scene.id] })) };
      await saveScenePlan(bindings.DB, taskId, scenePlan);
    }
    const splitScenes = scenePlan?.mode === 'SPLIT' ? scenePlan.scenes : [];
    const preferences = await getShopPreferences(bindings.DB, (await currentAccount())!.id);
    const reusable = existing.filter((asset) => asset.status === 'COMPLETED' && asset.batchId.startsWith(`asset_dynamic_${ASSET_PLAN_VERSION}_`));
    if (!options.force && !options.guidance && !options.count && !options.style && reusable.length > 0 && existing.every((asset) => asset.status === 'COMPLETED')) return Response.json({ assets: existing, summary: summarize(existing), reused: true });

    const approved = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
    if (approved.length === 0 || approved.length < passport.platformDrafts.length) {
      return Response.json({ error: '请先完成所有平台 Listing 审核，再生成视觉素材' }, { status: 409 });
    }
    const priorImages = existing.filter((asset) => asset.status === 'COMPLETED' && asset.kind !== 'VIDEO');
    const decision = options.confirmedBrief
      ? { scope: 'FULL_SET' as const, count: options.count, style: options.style, targetIndices: [] as number[] }
      : await callBailianVisualIntent(planningConfig, {
          request: options.guidance || '请根据当前商品生成图片',
          existingAssets: priorImages.map(({ kind, title, note }) => ({ kind, title, note })),
        });
    const images = await bindings.DB.prepare(
      `SELECT id, object_key, content_type FROM task_files
       WHERE task_id = ? AND content_type LIKE 'image/%' ORDER BY created_at ASC`,
    ).bind(taskId).all<ImageFileRow>();
    const image = images.results[0];
    if (!image) return Response.json({ error: '当前商品没有可用的原始图片，无法生成视觉素材' }, { status: 409 });
    const source = await bindings.UPLOADS.get(image.object_key);
    if (!source) return Response.json({ error: '对象存储中未找到原始商品图' }, { status: 404 });
    const bytes = new Uint8Array(await source.arrayBuffer());
    const listings = approved.flatMap((draft) => isListingDraftPayload(draft.payload) ? [draft.payload] : []);
    const sceneListings = approved.flatMap((draft) => isListingDraftPayload(draft.payload) ? [{ sceneId: draft.sceneId, listing: draft.payload }] : []);
    const planningContext = {
      productName: task.productName,
      facts: passport.facts,
      listings,
      platforms: task.platforms,
      markets: task.markets,
      sourceImageCount: images.results.length,
      sourceImageIds: images.results.map(image=>image.id),
      styleGuidance: decision.style,
      existingAssets: decision.targetIndices.length ? priorImages : [],
      targetIndices: decision.targetIndices,
      preferences,
    };
    const plan = splitScenes.length && !decision.targetIndices.length
      ? (() => { const scenePlans = splitScenes.map((scene) => callBailianAssetPlanning(planningConfig, {
          ...planningContext,
          listings: sceneListings.filter((entry) => entry.sceneId === scene.id).map((entry) => entry.listing),
          scenes: [scene],
          sceneListings: sceneListings.filter((entry) => entry.sceneId === scene.id),
          requestedCount: scene.imageCount ?? 1,
          userGuidance: `只为「${scene.name}」生成 ${scene.imageCount ?? 1} 张不同图片。${options.confirmedBrief ? options.notes || '' : options.guidance || ''}`,
        })); return Promise.all(scenePlans).then((parts) => ({ assets: parts.flatMap((part) => part.assets), model: parts[0].model })); })()
      : callBailianAssetPlanning(planningConfig, {
          ...planningContext, scenes: splitScenes, sceneListings, userGuidance: options.guidance,
          requestedCount: decision.targetIndices.length ? null : decision.count,
        });
    const resolvedPlan = await plan;
    if (decision.targetIndices.length) resolvedPlan.assets.forEach((spec, index) => { spec.sceneId = priorImages[decision.targetIndices[index] - 1]?.sceneId ?? 'base'; });
    if (splitScenes.length && !decision.targetIndices.length) resolvedPlan.assets.forEach((spec) => {
      const scene = splitScenes.find((item) => item.id === spec.sceneId);
      if (scene) spec.title = `${scene.name} · ${spec.title}`;
    });
    const sceneFor = (sceneId?: string) => splitScenes.find((scene) => scene.id === sceneId) ?? null;
    const listingsFor = (sceneId?: string) => sceneId && sceneId !== 'base'
      ? sceneListings.filter((entry) => entry.sceneId === sceneId).map((entry) => entry.listing)
      : listings;
    const batchId = `asset_dynamic_${ASSET_PLAN_VERSION}_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();

    if (decision.targetIndices.length) {
      const replacements = new Map<number, { id: string; spec: typeof resolvedPlan.assets[number]; prompt: string; objectKey: string; contentType: string; model: string; width: number | null; height: number | null; sourceFileId: string; reviewWarning: string | null }>();
      for (const [position, targetIndex] of decision.targetIndices.entries()) {
        const spec = resolvedPlan.assets[position];
        const oldAsset = priorImages[targetIndex - 1];
        let reference = { bytes, contentType: image.content_type, sourceFileId: image.id };
        if (spec.sourceMode === 'CURRENT') {
          const oldRow = await bindings.DB.prepare("SELECT object_key, content_type FROM generated_assets WHERE task_id=? AND id=? AND status='COMPLETED'")
            .bind(taskId, oldAsset.id).first<{ object_key: string; content_type: string }>();
          if (!oldRow?.object_key) throw new Error(`第 ${targetIndex} 张旧图不可用，请改用原始商品图重做`);
          const oldImage = await bindings.UPLOADS.get(oldRow.object_key);
          if (!oldImage) throw new Error(`第 ${targetIndex} 张旧图文件不存在`);
          reference = { bytes: new Uint8Array(await oldImage.arrayBuffer()), contentType: oldRow.content_type, sourceFileId: oldAsset.sourceFileId };
        }
        const prompt = buildAssetGenerationPrompt({ spec, scene: sceneFor(spec.sceneId), productName: task.productName, facts: passport.facts, listings: listingsFor(spec.sceneId), previousAsset: spec.sourceMode === 'CURRENT' ? oldAsset : null, preferences });
        const { generated, reviewWarning } = await generateVerifiedImage(config, planningConfig, {
          bytes: reference.bytes, contentType: reference.contentType,
        }, spec, prompt, options.guidance, { bytes, contentType: image.content_type }, resolvedPlan.assets.filter((_, index) => index !== position).map((item) => `${item.kind}｜${item.title}`));
        const id = `asset_${crypto.randomUUID()}`;
        const objectKey = `generated/${taskId}/${batchId}/${id}.png`;
        await bindings.UPLOADS.put(objectKey, generated.bytes, {
          httpMetadata: { contentType: generated.contentType },
          customMetadata: { taskId, sourceFileId: oldAsset.sourceFileId, model: generated.model, kind: spec.kind, planVersion: ASSET_PLAN_VERSION },
        });
        replacements.set(targetIndex, { id, spec, prompt, objectKey, contentType: generated.contentType, model: generated.model, width: generated.width, height: generated.height, sourceFileId: reference.sourceFileId, reviewWarning });
      }
      const retainedAssetIds: Record<string, string> = {};
      const writes = priorImages.map((oldAsset, position) => {
        const index = position + 1;
        const timestamp = new Date(Date.parse(createdAt) + position).toISOString();
        const replacement = replacements.get(index);
        if (replacement) return prepareGeneratedAssetInsert(bindings.DB, {
          id: replacement.id, taskId, sourceFileId: replacement.sourceFileId, batchId, sceneId: replacement.spec.sceneId,
          kind: replacement.spec.kind, title: replacement.spec.title, note: replacement.spec.note,
          prompt: replacement.prompt, objectKey: replacement.objectKey, contentType: replacement.contentType,
          model: replacement.model, status: 'COMPLETED', width: replacement.width, height: replacement.height,
          error: replacement.reviewWarning, createdAt: timestamp, completedAt: timestamp,
        });
        retainedAssetIds[oldAsset.id] = oldAsset.id;
        return bindings.DB.prepare("UPDATE generated_assets SET batch_id=?, created_at=? WHERE task_id=? AND id=? AND status='COMPLETED'")
          .bind(batchId, timestamp, taskId, oldAsset.id);
      });
      await bindings.DB.batch(writes);
      const assets = await listLatestGeneratedAssets(bindings.DB, taskId);
      return Response.json({ assets, summary: summarize(assets), reused: false, retainedAssetIds, plan: resolvedPlan.assets, plannerModel: resolvedPlan.model, decision });
    }

    const prepared: PromiseSettledResult<{
      spec: typeof resolvedPlan.assets[number]; prompt: string;
      generated: Awaited<ReturnType<typeof generateVerifiedImage>>['generated']; reviewWarning: string | null;
      id: string; position: number;
    }>[] = [];
    for (let start = 0; start < resolvedPlan.assets.length; start += 6) {
      const batch = await Promise.allSettled(resolvedPlan.assets.slice(start, start + 6).map(async (spec, offset) => {
        const position = start + offset;
        const prompt = buildAssetGenerationPrompt({ spec, scene: sceneFor(spec.sceneId), productName: task.productName, facts: passport.facts, listings: listingsFor(spec.sceneId), preferences });
        const sceneGuidance = options.confirmedBrief && splitScenes.length ? `本张属于「${sceneFor(spec.sceneId)?.name ?? spec.sceneId}」场景。${options.notes ?? ''}` : options.guidance;
        const { generated, reviewWarning } = await generateVerifiedImage(config, planningConfig, { bytes, contentType: image.content_type }, spec, prompt, sceneGuidance, { bytes, contentType: image.content_type }, resolvedPlan.assets.filter((item) => item !== spec && item.sceneId === spec.sceneId).map((item) => `${item.kind}｜${item.title}`));
        return { spec, prompt, generated, reviewWarning, id: `asset_${crypto.randomUUID()}`, position };
      }));
      prepared.push(...batch);
    }
    if (!prepared.some((result) => result.status === 'fulfilled')) {
      const failure = prepared[0].status === 'rejected' ? prepared[0].reason : null;
      throw failure instanceof Error ? failure : new Error('本轮图片都未通过验收，已有图片保持不变');
    }
    const writes = await Promise.all(prepared.map(async (result, position) => {
      const spec = resolvedPlan.assets[position];
      const timestamp = new Date(Date.parse(createdAt) + position).toISOString();
      if (result.status === 'rejected') {
        const reason = result.reason instanceof Error ? result.reason.message : '图片生成失败';
        return prepareGeneratedAssetInsert(bindings.DB, {
          id: `asset_${crypto.randomUUID()}`, taskId, sourceFileId: image.id, batchId, sceneId: spec.sceneId,
          kind: spec.kind, title: spec.title, note: spec.note,
          prompt: '', objectKey: null, contentType: null, model: config.model, status: 'FAILED',
          width: null, height: null, error: reason, createdAt: timestamp, completedAt: timestamp,
        });
      }
      const { prompt, generated, reviewWarning, id } = result.value;
      const objectKey = `generated/${taskId}/${batchId}/${id}.png`;
      await bindings.UPLOADS.put(objectKey, generated.bytes, {
        httpMetadata: { contentType: generated.contentType },
        customMetadata: { taskId, sourceFileId: image.id, model: generated.model, kind: spec.kind, planVersion: ASSET_PLAN_VERSION },
      });
      return prepareGeneratedAssetInsert(bindings.DB, {
        id, taskId, sourceFileId: image.id, batchId, sceneId: spec.sceneId, kind: spec.kind, title: spec.title, note: spec.note,
        prompt, objectKey, contentType: generated.contentType, model: generated.model, status: 'COMPLETED',
        width: generated.width, height: generated.height, error: reviewWarning, createdAt: timestamp, completedAt: timestamp,
      });
    }));
    await bindings.DB.batch(writes);
    const assets = await listLatestGeneratedAssets(bindings.DB, taskId);
    return Response.json({ assets, summary: summarize(assets), reused: false, plan: resolvedPlan.assets, plannerModel: resolvedPlan.model, decision });
  } catch (error) {
    const message = error instanceof Error ? error.message : '视觉素材生成失败';
    return Response.json({ error: message }, { status: message.startsWith('图片生成参数无效') ? 400 : /百炼|素材生成|图片/.test(message) ? 502 : 500 });
  }
}

export const GET = withAuthentication(handleGET);
export const POST = withAuthentication(handlePOST);
