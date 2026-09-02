import type { ParseStatus, ParserKind, UnifiedParseResult } from '../domain/document-parsing';

interface ParseResultRow {
  result_json: string;
}

export async function getParseResults(DB: D1Database, taskId: string): Promise<UnifiedParseResult[]> {
  const result = await DB.prepare(
    `SELECT result_json FROM file_parse_results
     WHERE task_id = ? ORDER BY created_at ASC`,
  ).bind(taskId).all<ParseResultRow>();

  return result.results.flatMap((row) => {
    try {
      return [JSON.parse(row.result_json) as UnifiedParseResult];
    } catch {
      return [];
    }
  });
}

export async function getParseResultForFile(DB: D1Database, fileId: string): Promise<UnifiedParseResult | null> {
  const row = await DB.prepare(
    'SELECT result_json FROM file_parse_results WHERE file_id = ?',
  ).bind(fileId).first<ParseResultRow>();
  if (!row) return null;
  try {
    return JSON.parse(row.result_json) as UnifiedParseResult;
  } catch {
    return null;
  }
}

export function prepareParseResultWrite(DB: D1Database, result: UnifiedParseResult): D1PreparedStatement {
  return DB.prepare(
    `INSERT INTO file_parse_results
     (id, task_id, file_id, parser_kind, status, schema_version, result_json, text_preview,
      warnings_json, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       parser_kind = excluded.parser_kind,
       status = excluded.status,
       schema_version = excluded.schema_version,
       result_json = excluded.result_json,
       text_preview = excluded.text_preview,
       warnings_json = excluded.warnings_json,
       error = excluded.error,
       updated_at = excluded.updated_at`,
  ).bind(
    result.id,
    result.taskId,
    result.fileId,
    result.parserKind satisfies ParserKind,
    result.status satisfies ParseStatus,
    result.schemaVersion,
    JSON.stringify(result),
    result.text.slice(0, 1_000),
    JSON.stringify(result.warnings),
    result.error,
    result.startedAt,
    result.completedAt,
  );
}
