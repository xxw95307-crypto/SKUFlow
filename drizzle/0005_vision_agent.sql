PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vision_agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  passport_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT,
  usage_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (passport_id) REFERENCES product_passports(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES task_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vision_runs_task_created
ON vision_agent_runs(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vision_runs_file_created
ON vision_agent_runs(file_id, created_at DESC);

PRAGMA optimize;
