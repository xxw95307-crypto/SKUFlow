CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, username TEXT UNIQUE, phone TEXT UNIQUE, name TEXT NOT NULL, password_hash TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS app_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES app_users(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(user_id,expires_at);
CREATE TABLE IF NOT EXISTS sms_challenges (phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, sent_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS auth_rate_limits (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(provider,subject), FOREIGN KEY(user_id) REFERENCES app_users(id) ON DELETE CASCADE);
