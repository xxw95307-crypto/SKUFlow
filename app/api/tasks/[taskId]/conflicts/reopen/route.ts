import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { resetPlannedDrafts } from '@/lib/server/passport-store';

export const dynamic = 'force-dynamic';

// 将任务中全部已裁决（RESOLVED/DISMISSED）的图文冲突重置为待确认（OPEN），
// 清空旧裁决记录；商家随后可在对话中重新逐项确认。
// 事实当前的取值保持不变，直到商家在重开后做出新的选择。
async function handlePUT(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const { DB } = getBindings();

    const task = await DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(taskId).first<{ id: string }>();
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

    const published = await DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_drafts WHERE task_id = ? AND status = 'DRAFT_CREATED'",
    ).bind(taskId).first<{ count: number }>();
    if ((published?.count ?? 0) > 0) {
      return Response.json({ error: '已有平台测试草稿发布，不能再重开冲突' }, { status: 409 });
    }

    const passport = await DB.prepare('SELECT id FROM product_passports WHERE task_id = ?')
      .bind(taskId)
      .first<{ id: string }>();
    if (!passport) return Response.json({ error: 'Product passport not found' }, { status: 404 });

    const now = new Date().toISOString();
    const result = await DB.prepare(
      `UPDATE fact_conflicts
       SET status = 'OPEN', resolution_json = NULL, updated_at = ?
       WHERE passport_id = ? AND status != 'OPEN'`,
    ).bind(now, passport.id).run();

    // 事实被重新裁决后旧审校稿不再可信，作废未发布草稿。
    await resetPlannedDrafts(DB, taskId);

    return Response.json({
      reopened: result.meta?.changes ?? 0,
      note: '冲突已重置为待确认，旧的裁决记录已清除；事实当前取值保持不变，直到你做出新的选择。',
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to reopen conflicts' },
      { status: 500 },
    );
  }
}

export const PUT = withAuthentication(handlePUT);
