CREATE TABLE IF NOT EXISTS generated_assets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source_file_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL,
  prompt TEXT NOT NULL,
  object_key TEXT UNIQUE,
  content_type TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (source_file_id) REFERENCES task_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_generated_assets_task_created
ON generated_assets(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_assets_task_batch
ON generated_assets(task_id, batch_id);

PRAGMA optimize;
