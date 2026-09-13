CREATE TABLE IF NOT EXISTS media_order_plans (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,status TEXT NOT NULL,plan_json TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_media_order_plans_task ON media_order_plans(task_id,created_at DESC);
