import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { loadBailianConfig, missingBailianConfig } from '@/lib/config/bailian';
import { callBailianScenePlanning } from '@/lib/ai/bailian-client';
import { MAX_SCENES, type ScenePlan } from '@/lib/domain/scene-plan';
import { getProductPassport } from '@/lib/server/passport-store';
import { getScenePlan } from '@/lib/server/scene-plan-store';
import { getTaskSnapshot } from '@/lib/server/task-store';

export const dynamic = 'force-dynamic';

async function handleGET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  await ensureSchema();
  const { taskId } = await context.params;
  const { DB } = getBindings();
  if (!await getTaskSnapshot(DB, taskId)) return Response.json({ error: '商品任务不存在' }, { status: 404 });
  return Response.json({ plan: await getScenePlan(DB, taskId) });
}

async function handlePOST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const body = await request.json() as { mode?: unknown; count?: unknown; directions?: unknown };
    if (body.mode !== 'SINGLE' && body.mode !== 'SPLIT') return Response.json({ error: '请选择常规上新或场景裂变' }, { status: 400 });
    const count = body.mode === 'SINGLE' ? 1 : body.count;
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_SCENES || (body.mode === 'SPLIT' && (count as number) < 2)) {
      return Response.json({ error: `裂变版本需为 2–${MAX_SCENES} 套` }, { status: 400 });
    }
    const directions = Array.isArray(body.directions) ? body.directions.map((value) => typeof value === 'string' ? value.trim().slice(0, 300) : '') : [];
    if (directions.length > MAX_SCENES) return Response.json({ error: '场景方向数量过多' }, { status: 400 });
    const bindings = getBindings();
    const { DB } = bindings;
    const [task, passport, existing] = await Promise.all([
      getTaskSnapshot(DB, taskId), getProductPassport(DB, taskId), getScenePlan(DB, taskId),
    ]);
    if (!task || !passport) return Response.json({ error: '商品任务不存在' }, { status: 404 });
    if (passport.conflicts.some((conflict) => conflict.status === 'OPEN') || passport.facts.length === 0) {
      return Response.json({ error: '请先完成商品信息核对' }, { status: 409 });
    }
    if (passport.platformDrafts.some((draft) => draft.status !== 'PLANNED' || Object.keys(draft.payload).length > 0)) {
      return Response.json({ error: '场景方案需在生成 Listing 前确认' }, { status: 409 });
    }
    const baseDrafts = passport.platformDrafts.filter((draft) => draft.sceneId === 'base');
    const targetDrafts = baseDrafts.length ? baseDrafts : passport.platformDrafts.filter((draft) => draft.sceneId === passport.platformDrafts[0]?.sceneId);
    if (!targetDrafts.length) return Response.json({ error: '请先选择目标平台与站点' }, { status: 409 });

    let scenes: ScenePlan['scenes'];
    if (body.mode === 'SINGLE') scenes = [{ id: 'base', name: '常规上新', visualBrief: '', copyBrief: '' }];
    else {
      const config = loadBailianConfig(bindings);
      const missing = missingBailianConfig(config);
      if (missing.length) return Response.json({ error: `场景策划模型配置不完整：${missing.join('、')}` }, { status: 503 });
      scenes = await callBailianScenePlanning(config, { productName: task.productName, facts: passport.facts, count: count as number, directions });
    }
    const now = new Date().toISOString();
    const plan: ScenePlan = { mode: body.mode, scenes, confirmedAt: now };
    await DB.batch([
      DB.prepare('DELETE FROM platform_drafts WHERE task_id=?').bind(taskId),
      ...scenes.flatMap((scene) => targetDrafts.map((draft) => DB.prepare(`INSERT INTO platform_drafts
        (id,task_id,passport_id,platform_id,market,locale,scene_id,category_id,status,schema_version,payload_json,validation_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?, 'PLANNED',NULL,'{}','[]',?,?)`)
        .bind(`draft_${crypto.randomUUID()}`, taskId, passport.id, draft.platformId, draft.market, draft.locale, scene.id, draft.categoryId, now, now))),
      DB.prepare(`INSERT INTO task_scene_plans (task_id,plan_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET plan_json=excluded.plan_json,updated_at=excluded.updated_at`)
        .bind(taskId, JSON.stringify(plan), now),
    ]);
    return Response.json({ plan, passport: await getProductPassport(DB, taskId), replaced: existing !== null });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '场景方案保存失败' }, { status: 500 });
  }
}

export const GET = withAuthentication(handleGET);
export const POST = withAuthentication(handlePOST);
