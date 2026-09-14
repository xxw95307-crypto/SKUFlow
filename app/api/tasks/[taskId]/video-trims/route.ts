import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { getProductPassport } from '@/lib/server/passport-store';
import { isVideoContainer, validateVideoTrimRange } from '@/lib/domain/video-trim';

export const dynamic = 'force-dynamic';

async function ready(taskId: string) {
  const b = getBindings();
  const p = await getProductPassport(b.DB, taskId);
  if (!p || p.conflicts.some(c => c.status === 'OPEN') || !p.platformDrafts.length
    || p.platformDrafts.some(d => d.status !== 'APPROVED')) throw new Error('请先确认所有 Listing；已发布任务请在新任务中编辑');
  return b;
}

async function handlePOST(request: Request, ctx: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await ctx.params;
    const b = await ready(taskId);
    const body = await request.json() as { videoId?: string; start?: number; end?: number; guidance?: string };
    const rows = await b.DB.prepare("SELECT id,source_file_id,plan_json FROM video_jobs WHERE task_id=? AND status='SUCCEEDED' ORDER BY created_at DESC,id DESC LIMIT 50")
      .bind(taskId).all<{ id: string; source_file_id: string; plan_json: string }>();
    if (!rows.results.length) return Response.json({ error: '当前没有已生成的视频可供裁剪' }, { status: 409 });
    if (body.videoId && !rows.results.some(r => r.id === body.videoId)) return Response.json({ error: '目标视频不属于当前任务或尚未完成' }, { status: 404 });
    // Persist a confirmation card, never treat inferred seconds as an approved edit.
    const id = `video_${crypto.randomUUID()}`;
    const source = rows.results.find(r => r.id === body.videoId);
    const plan = { title: '视频裁剪 · 待确认', duration: 0, resolution: '原视频', shots: [], trim: {
      sourceVideoId: source?.id ?? null, start: typeof body.start === 'number' ? body.start : null,
      end: typeof body.end === 'number' ? body.end : null, guidance: String(body.guidance ?? '').slice(0, 1000),
    } };
    await b.DB.prepare("UPDATE video_jobs SET status='CANCELED' WHERE task_id=? AND status='TRIM_DRAFT'").bind(taskId).run();
    await b.DB.prepare("INSERT INTO video_jobs(id,task_id,source_file_id,plan_json,status,created_at) VALUES(?,?,?,?,'TRIM_DRAFT',?)")
      .bind(id, taskId, source?.source_file_id ?? rows.results[0].source_file_id, JSON.stringify(plan), new Date().toISOString()).run();
    return Response.json({ trimId: id });
  } catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
}

async function handlePUT(request: Request, ctx: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await ctx.params;
    const b = await ready(taskId);
    if (Number(request.headers.get('content-length')) > 100 * 1024 * 1024) throw new Error('裁剪视频不能超过 100MB');
    const form = await request.formData();
    const trimId = String(form.get('trimId') ?? '');
    const sourceVideoId = String(form.get('sourceVideoId') ?? '');
    const draft = await b.DB.prepare("SELECT status FROM video_jobs WHERE task_id=? AND id=?").bind(taskId, trimId).first<{ status: string }>();
    if (!draft) return Response.json({ error: '裁剪任务不存在' }, { status: 404 });
    if (draft.status === 'SUCCEEDED') return Response.json({ id: trimId }); // idempotent upload retry
    if (draft.status !== 'TRIM_DRAFT') throw new Error('裁剪任务已取消，请重新打开裁剪卡');
    const source = await b.DB.prepare("SELECT source_file_id,plan_json FROM video_jobs WHERE task_id=? AND id=? AND status='SUCCEEDED'")
      .bind(taskId, sourceVideoId).first<{ source_file_id: string; plan_json: string }>();
    if (!source) return Response.json({ error: '原视频不存在或尚未完成' }, { status: 404 });
    const original = JSON.parse(source.plan_json);
    const range = validateVideoTrimRange(Number(form.get('start')), Number(form.get('end')), original.duration);
    const file = form.get('file');
    if (!(file instanceof File) || !file.size || file.size > 100 * 1024 * 1024) throw new Error('请选择有效的视频文件（不超过100MB）');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isVideoContainer(bytes, file.type)) throw new Error('裁剪结果必须为真实 MP4 或 WebM 视频');
    const plan = { ...original, title: `${original.title} · 裁剪版`, duration: range.end - range.start, contentType: file.type,
      shots: [`保留原视频 ${range.start.toFixed(2)}–${range.end.toFixed(2)} 秒`], trim: { sourceVideoId, ...range } };
    const key = `generated/${taskId}/videos/${trimId}.${file.type === 'video/webm' ? 'webm' : 'mp4'}`;
    await b.UPLOADS.put(key, bytes, { httpMetadata: { contentType: file.type } });
    const changed = await b.DB.prepare("UPDATE video_jobs SET status='SUCCEEDED',source_file_id=?,plan_json=?,object_key=?,error=NULL WHERE task_id=? AND id=? AND status='TRIM_DRAFT'")
      .bind(source.source_file_id, JSON.stringify(plan), key, taskId, trimId).run();
    if (!changed.meta.changes) throw new Error('裁剪任务状态已改变，请刷新后确认');
    await b.DB.prepare("UPDATE media_order_plans SET status='INVALIDATED' WHERE task_id=? AND status IN ('DRAFT','APPROVED','CONFIRMED')").bind(taskId).run();
    return Response.json({ id: trimId, videoUrl: `/api/tasks/${taskId}/videos/${trimId}/file` });
  } catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
}

export const POST = withAuthentication(handlePOST);
export const PUT = withAuthentication(handlePUT);
