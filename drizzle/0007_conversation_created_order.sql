CREATE INDEX IF NOT EXISTS idx_agent_conversations_created
ON agent_conversations(created_at DESC);

PRAGMA optimize;
