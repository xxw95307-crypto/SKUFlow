import { withAuthentication } from '@/lib/server/auth';
import { ensureSchema, getBindings } from '@/db/client';
import { summarizeParseResults, type UnifiedParseResult } from '@/lib/domain/document-parsing';
import type { TaskFileStatus, TaskStatus } from '@/lib/domain/task';
import { createFailedParseResult, parseSourceFile } from '@/lib/parsers/source-file-parser';
import { getParseResultForFile, getParseResults, prepareParseResultWrite } from '@/lib/server/parse-store';
import { getTaskSnapshot, prepareTaskTransition } from '@/lib/server/task-store';
import { assertTransition } from '@/lib/workflow/task-machine';

export const dynamic = 'force-dynamic';

interface TaskRow {
  id: string;
  status: TaskStatus;
}

interface FileRow {
  id: string;
  filename: string;
  object_key: string;
  content_type: string;
  size: number;
  status: TaskFileStatus;
}

async function parseRequestOptions(request: Request): Promise<{ force: boolean }> {
  const raw = await request.text();
  if (!raw.trim()) return { force: false };
  try {
    const value = JSON.parse(raw) as { force?: unknown };
    return { force: value.force === true };
  } catch {
    throw new Error('请求 JSON 格式无效');
  }
}

async function handleGET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const { DB } = getBindings();
    const task = await getTaskSnapshot(DB, taskId);
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
    const results = await getParseResults(DB, taskId);
    return Response.json({ task, results, summary: summarizeParseResults(results) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unable to load parse results' },
      { status: 500 },
    );
  }
}

async function handlePOST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    await ensureSchema();
    const { taskId } = await context.params;
    const options = await parseRequestOptions(request);
    const { DB, UPLOADS } = getBindings();
    const task = await DB.prepare('SELECT id, status FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<TaskRow>();
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

    if (task.status === 'FILES_PARSED' && !options.force) {
      const results = await getParseResults(DB, taskId);
      return Response.json({ task: await getTaskSnapshot(DB, taskId), results, summary: summarizeParseResults(results) });
    }

    if (!['CREATED', 'INGESTING', 'FILES_PARSED', 'FAILED'].includes(task.status)) {
      return Response.json({ error: `当前任务状态 ${task.status} 不允许重新解析源文件` }, { status: 409 });
    }

    let workingStatus = task.status;
    if (workingStatus !== 'INGESTING') {
      assertTransition(workingStatus, 'INGESTING');
      const now = new Date().toISOString();
      await DB.batch(prepareTaskTransition(DB, {
        taskId,
        fromStatus: workingStatus,
        toStatus: 'INGESTING',
        actor: 'agent',
        note: options.force ? '重新执行统一文件解析' : '启动统一文件解析',
        now,
      }));
      workingStatus = 'INGESTING';
    }

    const files = await DB.prepare(
      `SELECT id, filename, object_key, content_type, size, status
       FROM task_files WHERE task_id = ? ORDER BY created_at ASC`,
    ).bind(taskId).all<FileRow>();
    if (files.results.length === 0) return Response.json({ error: '任务没有源文件' }, { status: 409 });

    const results: UnifiedParseResult[] = [];
    for (const file of files.results) {
      const existing = await getParseResultForFile(DB, file.id);
      if (!options.force && existing && existing.status !== 'FAILED') {
        results.push(existing);
        continue;
      }

      await DB.prepare("UPDATE task_files SET status = 'PARSING' WHERE id = ? AND task_id = ?")
        .bind(file.id, taskId)
        .run();
      let bytes = new Uint8Array(0);
      let result: UnifiedParseResult;
      try {
        const source = await UPLOADS.get(file.object_key);
        if (!source) throw new Error('对象存储中未找到源文件');
        bytes = new Uint8Array(await source.arrayBuffer());
        result = await parseSourceFile({
          taskId,
          fileId: file.id,
          filename: file.filename,
          contentType: file.content_type,
          bytes,
          resultId: existing?.id,
        });
      } catch (error) {
        result = await createFailedParseResult({
          taskId,
          fileId: file.id,
          filename: file.filename,
          contentType: file.content_type,
          bytes,
          resultId: existing?.id,
        }, error);
      }

      const fileStatus: TaskFileStatus = result.status === 'COMPLETED'
        ? 'PARSED'
        : result.status === 'PARTIAL' ? 'PARTIAL' : 'FAILED';
      await DB.batch([
        prepareParseResultWrite(DB, result),
        DB.prepare('UPDATE task_files SET status = ? WHERE id = ? AND task_id = ?')
          .bind(fileStatus, file.id, taskId),
      ]);
      results.push(result);
    }

    const summary = summarizeParseResults(results);
    const finalStatus: TaskStatus = summary.completed + summary.partial > 0 ? 'FILES_PARSED' : 'FAILED';
    assertTransition(workingStatus, finalStatus);
    const completedAt = new Date().toISOString();
    await DB.batch(prepareTaskTransition(DB, {
      taskId,
      fromStatus: workingStatus,
      toStatus: finalStatus,
      actor: 'agent',
      note: finalStatus === 'FILES_PARSED'
        ? `统一解析完成：${summary.completed} 成功，${summary.partial} 部分成功，${summary.failed} 失败`
        : `统一解析失败：${summary.failed} 个文件均未得到可用结果`,
      now: completedAt,
    }));

    return Response.json({ task: await getTaskSnapshot(DB, taskId), results, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to parse files';
    const clientError = message === '请求 JSON 格式无效';
    const conflict = message.startsWith('Invalid task transition');
    return Response.json({ error: message }, { status: clientError ? 400 : conflict ? 409 : 500 });
  }
}

export const GET = withAuthentication(handleGET);
export const POST = withAuthentication(handlePOST);
