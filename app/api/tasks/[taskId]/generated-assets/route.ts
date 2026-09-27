import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { ASSET_PLAN_VERSION, buildAssetGenerationPrompt, imageKindsFromRequest } from '@/lib/agents/asset-generation';
import { callBailianAssetPlanning, callBailianImageGeneration, checkGeneratedImageKind } from '@/lib/ai/bailian-client';
import { loadBailianConfig, loadBailianImageConfig, missingBailianConfig, missingBailianImageConfig } from '@/lib/config/bailian';
import type { GeneratedAsset, GeneratedAssetSummary } from '@/lib/domain/generated-asset';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { listLatestGeneratedAssets, prepareGeneratedAssetInsert } from '@/lib/server/generated-asset-store';
import { getProductPassport } from '@/lib/server/passport-store';
import { getTaskSnapshot } from '@/lib/server/task-store';

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

async function requestOptions(request: Request): Promise<{ force: boolean; guidance: string | null; count: number | null; style: string | null; targetIndices: number[] }> {
  const raw = await request.text();
  if (!raw.trim()) return { force: false, guidance: null, count: null, style: null, targetIndices: [] };
  try {
    const value = JSON.parse(raw) as { force?: unknown; guidance?: unknown; count?: unknown; style?: unknown; targetIndices?: unknown };
    if (value.count != null && (!Number.isInteger(value.count) || (value.count as number) < 1 || (value.count as number) > 6)) {
      throw new Error('图片数量需为 1–6 张');
    }
    const guidance = typeof value.guidance === 'string' ? value.guidance.trim().slice(0, 500) : '';
    const style = typeof value.style === 'string' ? value.style.trim().slice(0, 200) : '';
    const targetIndices = value.targetIndices == null ? [] : value.targetIndices;
    if (!Array.isArray(targetIndices) || targetIndices.length > 6 || targetIndices.some((index) => !Number.isInteger(index) || index < 1 || index > 6) || new Set(targetIndices).size !== targetIndices.length) {
      throw new Error('目标图片序号无效');
    }
    return { force: value.force === true, guidance: guidance || null, count: value.count == null ? null : value.count as number, style: style || null, targetIndices: [...targetIndices].sort((a, b) => a - b) };
  } catch {
    throw new Error('图片生成参数无效，请检查张数或目标图片序号');
  }
}

async function handleGET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const task = await getTaskSnapshot(getBindings().DB, taskId);
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
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
    const reusable = existing.filter((asset) => asset.status === 'COMPLETED' && asset.batchId.startsWith(`asset_dynamic_${ASSET_PLAN_VERSION}_`));
    if (!options.force && !options.guidance && !options.count && !options.style && reusable.length > 0) return Response.json({ assets: existing, summary: summarize(existing), reused: true });

    const approved = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
    if (approved.length === 0 || approved.length < passport.platformDrafts.length) {
      return Response.json({ error: '请先完成所有平台 Listing 审核，再生成视觉素材' }, { status: 409 });
    }
    const priorImages = existing.filter((asset) => asset.status === 'COMPLETED' && asset.kind !== 'VIDEO');
    if (options.targetIndices.some((index) => index > priorImages.length)) {
      return Response.json({ error: `当前只有 ${priorImages.length} 张图片，请指定有效的图片序号` }, { status: 400 });
    }
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
    const requiredKinds = options.targetIndices.length ? [] : imageKindsFromRequest(options.guidance ?? '');
    const requestedCount = options.targetIndices.length ? null : options.count ?? (requiredKinds.length > 1 ? requiredKinds.length : null);
    if (requestedCount != null && requiredKinds.length > requestedCount) {
      return Response.json({ error: '指定的图片类型数量超过总张数，请调整图片需求' }, { status: 400 });
    }
    const plan = await callBailianAssetPlanning(planningConfig, {
      productName: task.productName,
      facts: passport.facts,
      listings,
      platforms: task.platforms,
      markets: task.markets,
      sourceImageCount: images.results.length,
      sourceImageIds: images.results.map(image=>image.id),
      userGuidance: options.guidance,
      requestedCount,
      styleGuidance: options.style,
      existingAssets: priorImages,
      targetIndices: options.targetIndices,
      requiredKinds,
    });
    const batchId = `asset_dynamic_${ASSET_PLAN_VERSION}_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();

    if (options.targetIndices.length) {
      const replacements = new Map<number, { id: string; spec: typeof plan.assets[number]; prompt: string; objectKey: string; contentType: string; model: string; width: number | null; height: number | null; sourceFileId: string }>();
      for (const [position, targetIndex] of options.targetIndices.entries()) {
        const oldAsset = priorImages[targetIndex - 1];
        const spec = plan.assets[position];
        const oldRow = await bindings.DB.prepare("SELECT object_key, content_type FROM generated_assets WHERE task_id=? AND id=? AND status='COMPLETED'")
          .bind(taskId, oldAsset.id).first<{ object_key: string; content_type: string }>();
        if (!oldRow?.object_key) throw new Error(`第 ${targetIndex} 张旧图不可用，请重新生成整组图片`);
        const oldImage = await bindings.UPLOADS.get(oldRow.object_key);
        if (!oldImage) throw new Error(`第 ${targetIndex} 张旧图文件不存在`);
        const prompt = buildAssetGenerationPrompt({ spec, productName: task.productName, facts: passport.facts, listings, previousAsset: oldAsset });
        let generated = await callBailianImageGeneration(config, {
          bytes: new Uint8Array(await oldImage.arrayBuffer()), contentType: oldRow.content_type, prompt, size: spec.size,
        });
        if (spec.kind === 'MODEL' || spec.kind === 'POSTER') {
          let check = await checkGeneratedImageKind(planningConfig, { bytes: generated.bytes, contentType: generated.contentType, kind: spec.kind });
          if (!check.matches) {
            const source = await bindings.UPLOADS.get(oldRow.object_key);
            if (!source) throw new Error(`第 ${targetIndex} 张旧图文件不存在`);
            generated = await callBailianImageGeneration(config, {
              bytes: new Uint8Array(await source.arrayBuffer()), contentType: oldRow.content_type,
              prompt: `${prompt}\n\n上一版图片未满足要求：${check.reason}。请明显呈现${spec.kind === 'MODEL' ? '真人模特穿着商品' : '海报式设计构图'}。`,
              size: spec.size,
            });
            check = await checkGeneratedImageKind(planningConfig, { bytes: generated.bytes, contentType: generated.contentType, kind: spec.kind });
            if (!check.matches) throw new Error(`第 ${targetIndex} 张修改后仍未符合要求：${check.reason || '图片类型不符'}；旧图片已保留`);
          }
        }
        const id = `asset_${crypto.randomUUID()}`;
        const objectKey = `generated/${taskId}/${batchId}/${id}.png`;
        await bindings.UPLOADS.put(objectKey, generated.bytes, {
          httpMetadata: { contentType: generated.contentType },
          customMetadata: { taskId, sourceFileId: oldAsset.sourceFileId, model: generated.model, kind: spec.kind, planVersion: ASSET_PLAN_VERSION },
        });
        replacements.set(targetIndex, { id, spec, prompt, objectKey, contentType: generated.contentType, model: generated.model, width: generated.width, height: generated.height, sourceFileId: oldAsset.sourceFileId });
      }
      const retainedAssetIds: Record<string, string> = {};
      const writes = priorImages.map((oldAsset, position) => {
        const index = position + 1;
        const timestamp = new Date(Date.parse(createdAt) + position).toISOString();
        const replacement = replacements.get(index);
        if (replacement) return prepareGeneratedAssetInsert(bindings.DB, {
          id: replacement.id, taskId, sourceFileId: replacement.sourceFileId, batchId,
          kind: replacement.spec.kind, title: replacement.spec.title, note: replacement.spec.note,
          prompt: replacement.prompt, objectKey: replacement.objectKey, contentType: replacement.contentType,
          model: replacement.model, status: 'COMPLETED', width: replacement.width, height: replacement.height,
          error: null, createdAt: timestamp, completedAt: timestamp,
        });
        retainedAssetIds[oldAsset.id] = oldAsset.id;
        return bindings.DB.prepare("UPDATE generated_assets SET batch_id=?, created_at=? WHERE task_id=? AND id=? AND status='COMPLETED'")
          .bind(batchId, timestamp, taskId, oldAsset.id);
      });
      await bindings.DB.batch(writes);
      const assets = await listLatestGeneratedAssets(bindings.DB, taskId);
      return Response.json({ assets, summary: summarize(assets), reused: false, retainedAssetIds, plan: plan.assets, plannerModel: plan.model });
    }

    if (requiredKinds.length) {
      const prepared = await Promise.all(plan.assets.map(async (spec, position) => {
        const prompt = buildAssetGenerationPrompt({ spec, productName: task.productName, facts: passport.facts, listings });
        let generated = await callBailianImageGeneration(config, { bytes, contentType: image.content_type, prompt, size: spec.size });
        if ((spec.kind === 'MODEL' || spec.kind === 'POSTER') && requiredKinds.includes(spec.kind)) {
          let check = await checkGeneratedImageKind(planningConfig, { bytes: generated.bytes, contentType: generated.contentType, kind: spec.kind });
          if (!check.matches) {
            generated = await callBailianImageGeneration(config, {
              bytes, contentType: image.content_type,
              prompt: `${prompt}\n\n上一版图片未满足指定类型：${check.reason}。请纠正，必须清晰满足${spec.kind === 'MODEL' ? '真人模特实际穿着商品' : '真正的海报式视觉构图'}。`,
              size: spec.size,
            });
            check = await checkGeneratedImageKind(planningConfig, { bytes: generated.bytes, contentType: generated.contentType, kind: spec.kind });
            if (!check.matches) throw new Error(`第 ${position + 1} 张${spec.kind === 'MODEL' ? '模特图' : '海报图'}两次生成仍未符合要求：${check.reason || '图片类型不符'}；旧图片已保留`);
          }
        }
        return { spec, prompt, generated, id: `asset_${crypto.randomUUID()}`, position };
      }));
      const writes = await Promise.all(prepared.map(async ({ spec, prompt, generated, id, position }) => {
        const objectKey = `generated/${taskId}/${batchId}/${id}.png`;
        await bindings.UPLOADS.put(objectKey, generated.bytes, {
          httpMetadata: { contentType: generated.contentType },
          customMetadata: { taskId, sourceFileId: image.id, model: generated.model, kind: spec.kind, planVersion: ASSET_PLAN_VERSION },
        });
        const timestamp = new Date(Date.parse(createdAt) + position).toISOString();
        return prepareGeneratedAssetInsert(bindings.DB, {
          id, taskId, sourceFileId: image.id, batchId, kind: spec.kind, title: spec.title, note: spec.note,
          prompt, objectKey, contentType: generated.contentType, model: generated.model, status: 'COMPLETED',
          width: generated.width, height: generated.height, error: null, createdAt: timestamp, completedAt: timestamp,
        });
      }));
      await bindings.DB.batch(writes);
      const assets = await listLatestGeneratedAssets(bindings.DB, taskId);
      return Response.json({ assets, summary: summarize(assets), reused: false, plan: plan.assets, plannerModel: plan.model });
    }

    await Promise.all(plan.assets.map(async (spec) => {
      const id = `asset_${crypto.randomUUID()}`;
      const prompt = buildAssetGenerationPrompt({ spec, productName: task.productName, facts: passport.facts, listings });
      try {
        const generated = await callBailianImageGeneration(config, {
          bytes,
          contentType: image.content_type,
          prompt,
          size: spec.size,
        });
        const objectKey = `generated/${taskId}/${batchId}/${id}.png`;
        await bindings.UPLOADS.put(objectKey, generated.bytes, {
          httpMetadata: { contentType: generated.contentType },
          customMetadata: { taskId, sourceFileId: image.id, model: generated.model, kind: spec.kind, planVersion: ASSET_PLAN_VERSION },
        });
        await prepareGeneratedAssetInsert(bindings.DB, {
          id, taskId, sourceFileId: image.id, batchId, kind: spec.kind, title: spec.title, note: spec.note,
          prompt, objectKey, contentType: generated.contentType, model: generated.model, status: 'COMPLETED',
          width: generated.width, height: generated.height, error: null, createdAt, completedAt: new Date().toISOString(),
        }).run();
      } catch (error) {
        await prepareGeneratedAssetInsert(bindings.DB, {
          id, taskId, sourceFileId: image.id, batchId, kind: spec.kind, title: spec.title, note: spec.note,
          prompt, objectKey: null, contentType: null, model: config.model, status: 'FAILED', width: null, height: null,
          error: error instanceof Error ? error.message : '素材生成失败', createdAt, completedAt: new Date().toISOString(),
        }).run();
      }
    }));

    const assets = await listLatestGeneratedAssets(bindings.DB, taskId);
    const summary = summarize(assets);
    if (summary.completed === 0) {
      const reason = assets.find((asset) => asset.error)?.error || '图像模型未返回有效素材';
      return Response.json({ error: `视觉素材生成失败：${reason}`, assets, summary }, { status: 502 });
    }
    return Response.json({ assets, summary, reused: false, plan: plan.assets, plannerModel: plan.model });
  } catch (error) {
    const message = error instanceof Error ? error.message : '视觉素材生成失败';
    return Response.json({ error: message }, { status: message.startsWith('图片生成参数无效') ? 400 : /百炼|素材生成|图片/.test(message) ? 502 : 500 });
  }
}

export const GET = withAuthentication(handleGET);
export const POST = withAuthentication(handlePOST);
