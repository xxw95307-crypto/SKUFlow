import type {
  VisionAgentRun,
  VisionAnalysisOutput,
  VisionAnalysisSummary,
} from '../domain/vision-analysis';

interface VisionRunRow {
  id: string;
  task_id: string;
  passport_id: string;
  file_id: string;
  provider: 'BAILIAN';
  model: string;
  prompt_version: string;
  status: VisionAgentRun['status'];
  input_hash: string;
  result_json: string | null;
  usage_json: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapVisionRun(row: VisionRunRow): VisionAgentRun {
  return {
    id: row.id,
    taskId: row.task_id,
    passportId: row.passport_id,
    fileId: row.file_id,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    status: row.status,
    inputHash: row.input_hash,
    result: parseJson<VisionAnalysisOutput | null>(row.result_json, null),
    usage: parseJson<Record<string, number> | null>(row.usage_json, null),
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

const visionRunColumns = `id, task_id, passport_id, file_id, provider, model, prompt_version, status,
  input_hash, result_json, usage_json, error, created_at, completed_at`;

export async function getLatestVisionRuns(DB: D1Database, taskId: string): Promise<VisionAgentRun[]> {
  const result = await DB.prepare(
    `SELECT ${visionRunColumns}
     FROM vision_agent_runs WHERE task_id = ? ORDER BY created_at DESC`,
  ).bind(taskId).all<VisionRunRow>();
  const latestByFile = new Map<string, VisionAgentRun>();
  for (const row of result.results) {
    if (!latestByFile.has(row.file_id)) latestByFile.set(row.file_id, mapVisionRun(row));
  }
  return [...latestByFile.values()];
}

export async function getLatestCompletedVisionRuns(DB: D1Database, taskId: string): Promise<VisionAgentRun[]> {
  const result = await DB.prepare(
    `SELECT ${visionRunColumns}
     FROM vision_agent_runs
     WHERE task_id = ? AND status = 'COMPLETED'
     ORDER BY created_at DESC`,
  ).bind(taskId).all<VisionRunRow>();
  const latestByFile = new Map<string, VisionAgentRun>();
  for (const row of result.results) {
    if (!latestByFile.has(row.file_id)) latestByFile.set(row.file_id, mapVisionRun(row));
  }
  return [...latestByFile.values()];
}

export async function getLatestVisionRunForFile(DB: D1Database, fileId: string): Promise<VisionAgentRun | null> {
  const row = await DB.prepare(
    `SELECT ${visionRunColumns}
     FROM vision_agent_runs WHERE file_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(fileId).first<VisionRunRow>();
  return row ? mapVisionRun(row) : null;
}

export function prepareVisionRunStart(DB: D1Database, run: VisionAgentRun): D1PreparedStatement {
  return DB.prepare(
    `INSERT INTO vision_agent_runs
     (id, task_id, passport_id, file_id, provider, model, prompt_version, status, input_hash,
      result_json, usage_json, error, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, NULL, NULL, NULL, ?, NULL)`,
  ).bind(
    run.id,
    run.taskId,
    run.passportId,
    run.fileId,
    run.provider,
    run.model,
    run.promptVersion,
    run.inputHash,
    run.createdAt,
  );
}

export function prepareVisionRunComplete(
  DB: D1Database,
  input: {
    runId: string;
    model: string;
    output: VisionAnalysisOutput;
    usage: Record<string, number> | null;
    completedAt: string;
  },
): D1PreparedStatement {
  return DB.prepare(
    `UPDATE vision_agent_runs
     SET status = 'COMPLETED', model = ?, result_json = ?, usage_json = ?, error = NULL, completed_at = ?
     WHERE id = ?`,
  ).bind(input.model, JSON.stringify(input.output), JSON.stringify(input.usage), input.completedAt, input.runId);
}

export function prepareVisionRunFailure(
  DB: D1Database,
  runId: string,
  error: string,
  completedAt: string,
): D1PreparedStatement {
  return DB.prepare(
    `UPDATE vision_agent_runs SET status = 'FAILED', error = ?, completed_at = ? WHERE id = ?`,
  ).bind(error.slice(0, 500), completedAt, runId);
}

export function summarizeVisionRuns(runs: readonly VisionAgentRun[], totalImages: number): VisionAnalysisSummary {
  const completedRuns = runs.filter((run) => run.status === 'COMPLETED' && run.result);
  return {
    totalImages,
    completed: completedRuns.length,
    failed: runs.filter((run) => run.status === 'FAILED').length,
    pending: Math.max(0, totalImages - completedRuns.length - runs.filter((run) => run.status === 'FAILED').length),
    factsObserved: completedRuns.reduce((sum, run) => sum + (run.result?.facts.length ?? 0), 0),
    visibleTextCharacters: completedRuns.reduce((sum, run) => sum + (run.result?.visibleText.length ?? 0), 0),
  };
}
