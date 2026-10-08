CREATE TABLE IF NOT EXISTS task_scene_plans (
  task_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE platform_drafts_scene_migration (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  passport_id TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  market TEXT NOT NULL,
  locale TEXT NOT NULL,
  scene_id TEXT NOT NULL DEFAULT 'base',
  category_id TEXT,
  status TEXT NOT NULL,
  schema_version TEXT,
  payload_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (passport_id) REFERENCES product_passports(id) ON DELETE CASCADE,
  UNIQUE (task_id, platform_id, market, locale, scene_id)
);

INSERT INTO platform_drafts_scene_migration
  (id,task_id,passport_id,platform_id,market,locale,scene_id,category_id,status,schema_version,payload_json,validation_json,created_at,updated_at)
  SELECT id,task_id,passport_id,platform_id,market,locale,'base',category_id,status,schema_version,payload_json,validation_json,created_at,updated_at
  FROM platform_drafts;

DROP TABLE platform_drafts;
ALTER TABLE platform_drafts_scene_migration RENAME TO platform_drafts;
CREATE INDEX IF NOT EXISTS idx_drafts_task_platform ON platform_drafts(task_id, platform_id, market);

ALTER TABLE generated_assets ADD COLUMN scene_id TEXT NOT NULL DEFAULT 'base';
