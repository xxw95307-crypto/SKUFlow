CREATE TABLE IF NOT EXISTS shop_preferences (user_id TEXT PRIMARY KEY, preferences_json TEXT NOT NULL, confirmed_at TEXT NOT NULL, updated_at TEXT NOT NULL);
