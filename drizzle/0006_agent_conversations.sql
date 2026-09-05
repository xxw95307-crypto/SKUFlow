PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_conversations (
  id TEXT PRIMARY KEY,
  task_id TEXT UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  messages_json TEXT NOT NULL DEFAULT '[]',
  model_history_json TEXT NOT NULL DEFAULT '[]',
  tool_runs_json TEXT NOT NULL DEFAULT '[]',
  selected_assets_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_updated
ON agent_conversations(updated_at DESC);

PRAGMA optimize;
