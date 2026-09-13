CREATE TABLE IF NOT EXISTS resource_owners (kind TEXT NOT NULL CHECK(kind IN ('task','conversation')), resource_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(kind,resource_id));
CREATE INDEX IF NOT EXISTS resource_owners_user ON resource_owners(user_id,kind,resource_id);
CREATE TABLE IF NOT EXISTS account_migrations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
