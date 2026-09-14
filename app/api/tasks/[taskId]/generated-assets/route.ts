import {updateVideoJob} from '@/lib/server/video-jobs';
import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { ASSET_PLAN_VERSION, buildAssetGenerationPrompt } from '@/lib/agents/asset-generation';
import { callBailianAssetPlanning, callBailianImageGeneration } from '@/lib/ai/bailian-client';
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

async function requestOptions(request: Request): Promise<{ force: boolean; guidance: string | null }> {
  const raw = await request.text();
  if (!raw.trim()) return { force: false, guidance: null };
  try {
    const value = JSON.parse(raw) as { force?: unknown; guidance?: unknown };
    const guidance = typeof value.guidance === 'string' ? value.guidance.trim().slice(0, 500) : '';
    return { force: value.force === true, guidance: guidance || null };
  } catch {
    throw new Error('请求 JSON 格式无效');
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
    if (!options.force && reusable.length > 0) return Response.json({ assets: existing, summary: summarize(existing), reused: true });

    const approved = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
    if (approved.length === 0 || approved.length < passport.platformDrafts.length) {
      return Response.json({ error: '请先完成所有平台 Listing 审核，再生成视觉素材' }, { status: 409 });
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
    const plan = await callBailianAssetPlanning(planningConfig, {
      productName: task.productName,
      facts: passport.facts,
      listings,
      platforms: task.platforms,
      markets: task.markets,
      sourceImageCount: images.results.length,
      sourceImageIds: images.results.map(image=>image.id),
      userGuidance: options.guidance,
    });
    const batchId = `asset_dynamic_${ASSET_PLAN_VERSION}_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();

    let videoResult: {id?:string;status?:string;error?:string;reason:string} = {reason:plan.videoDecision.reason};
    if (plan.videoDecision.required && plan.videoDecision.plan) {
      const video = plan.videoDecision.plan;
      const id = `video_${crypto.randomUUID()}`;
      await bindings.DB.prepare("INSERT INTO video_jobs (id,task_id,source_file_id,plan_json,status,created_at) VALUES (?,?,?,?,'DRAFT',?)").bind(id,taskId,video.sourceFileId,JSON.stringify(video),createdAt).run();
      const response = await updateVideoJob(new Request(request.url,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id,action:'start'})}),{params:Promise.resolve({taskId})});
      const result = await response.json() as {job?:{status:string};error?:string};
      if (result.error) await bindings.DB.prepare("UPDATE video_jobs SET error=? WHERE id=? AND task_id=?").bind(result.error,id,taskId).run();
      videoResult = {id,status:result.job?.status,error:result.error,reason:plan.videoDecision.reason};
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
    return Response.json({ assets, summary, reused: false, video: videoResult, plan: plan.assets, plannerModel: plan.model });
  } catch (error) {
    const message = error instanceof Error ? error.message : '视觉素材生成失败';
    return Response.json({ error: message }, { status: message === '请求 JSON 格式无效' ? 400 : /百炼|素材生成|图片/.test(message) ? 502 : 500 });
  }
}

export const GET = withAuthentication(handleGET);
export const POST = withAuthentication(handlePOST);
