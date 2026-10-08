import { parseScenePlan, type ScenePlan } from '../domain/scene-plan.ts';

export async function getScenePlan(DB: D1Database, taskId: string): Promise<ScenePlan | null> {
  const row = await DB.prepare('SELECT plan_json FROM task_scene_plans WHERE task_id=?').bind(taskId).first<{ plan_json: string }>();
  return parseScenePlan(row?.plan_json ?? null);
}

export async function saveScenePlan(DB: D1Database, taskId: string, plan: ScenePlan): Promise<void> {
  await DB.prepare(`INSERT INTO task_scene_plans (task_id,plan_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET plan_json=excluded.plan_json,updated_at=excluded.updated_at`)
    .bind(taskId, JSON.stringify(plan), plan.confirmedAt).run();
}
