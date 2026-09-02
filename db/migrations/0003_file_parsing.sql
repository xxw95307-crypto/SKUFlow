PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS file_parse_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  file_id TEXT NOT NULL UNIQUE,
  parser_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  text_preview TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES task_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_parse_results_task_status
ON file_parse_results(task_id, status);

PRAGMA optimize;
