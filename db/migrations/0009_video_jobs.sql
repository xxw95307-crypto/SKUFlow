CREATE TABLE IF NOT EXISTS video_jobs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_file_id TEXT NOT NULL, plan_json TEXT NOT NULL, status TEXT NOT NULL, provider_task_id TEXT, object_key TEXT, error TEXT, created_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_video_jobs_task ON video_jobs(task_id,created_at DESC);
