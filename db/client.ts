import { env } from 'cloudflare:workers';
import { schemaStatements } from './schema';

export interface AppBindings {
  DB: D1Database;
  UPLOADS: R2Bucket;
  BAILIAN_API_KEY?: string;
  BAILIAN_BASE_URL?: string;
  BAILIAN_MODEL?: string;
  BAILIAN_IMAGE_MODEL?: string;
  BAILIAN_VIDEO_API_KEY?: string;
  BAILIAN_VIDEO_BASE_URL?: string;
  BAILIAN_VIDEO_MODEL?: string;
  SHOPIFY_DEV_STORE_DOMAIN?: string;
  SHOPIFY_DEV_CLIENT_ID?: string;
  SHOPIFY_DEV_CLIENT_SECRET?: string;
  SHOPIFY_API_VERSION?: string;
  AMAZON_SP_API_CLIENT_ID?: string;
  AMAZON_SP_API_CLIENT_SECRET?: string;
  AMAZON_SP_API_REFRESH_TOKEN?: string;
  AMAZON_SELLER_ID?: string;
  AMAZON_US_SELLER_ID?: string;
  AMAZON_SP_API_SANDBOX_CLIENT_ID?: string;
  AMAZON_SP_API_SANDBOX_CLIENT_SECRET?: string;
  AMAZON_SP_API_SANDBOX_REFRESH_TOKEN?: string;
  LEGACY_DATA_OWNER_EMAIL?: string;
  ALIYUN_PNVS_ACCESS_KEY_ID?: string;
  ALIYUN_PNVS_ACCESS_KEY_SECRET?: string;
  ALIYUN_PNVS_SIGN_NAME?: string;
  ALIYUN_PNVS_TEMPLATE_CODE?: string;
  WECHAT_APP_ID?: string;
  WECHAT_APP_SECRET?: string;
}

let schemaPromise: Promise<void> | null = null;

export function getBindings(): AppBindings {
  return env as unknown as AppBindings;
}

export async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const { DB } = getBindings();
      await DB.batch(schemaStatements.map((statement) => DB.prepare(statement)));
      // Older local previews created a row-based batch schema. CREATE TABLE IF NOT
      // EXISTS leaves that schema untouched, so bring its columns forward in place.
      const jobColumns = (await DB.prepare('PRAGMA table_info(batch_jobs)').all<{ name: string }>()).results.map((column) => column.name);
      if (!jobColumns.includes('source_label')) {
        await DB.prepare("ALTER TABLE batch_jobs ADD COLUMN source_label TEXT NOT NULL DEFAULT ''").run();
        if (jobColumns.includes('source_filename')) {
          await DB.prepare("UPDATE batch_jobs SET source_label=source_filename WHERE source_label=''").run();
        }
      }
      const itemColumns = (await DB.prepare('PRAGMA table_info(batch_items)').all<{ name: string }>()).results.map((column) => column.name);
      if (!itemColumns.includes('last_error')) {
        await DB.prepare('ALTER TABLE batch_items ADD COLUMN last_error TEXT').run();
      }
      const draftColumns = (await DB.prepare('PRAGMA table_info(platform_drafts)').all<{ name: string }>()).results.map((column) => column.name);
      if (!draftColumns.includes('scene_id')) {
        await DB.batch([
          DB.prepare(`CREATE TABLE platform_drafts_scene_migration (
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL, passport_id TEXT NOT NULL,
            platform_id TEXT NOT NULL, market TEXT NOT NULL, locale TEXT NOT NULL,
            scene_id TEXT NOT NULL DEFAULT 'base', category_id TEXT, status TEXT NOT NULL,
            schema_version TEXT, payload_json TEXT NOT NULL, validation_json TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (passport_id) REFERENCES product_passports(id) ON DELETE CASCADE,
            UNIQUE (task_id, platform_id, market, locale, scene_id))`),
          DB.prepare(`INSERT INTO platform_drafts_scene_migration
            (id,task_id,passport_id,platform_id,market,locale,scene_id,category_id,status,schema_version,payload_json,validation_json,created_at,updated_at)
            SELECT id,task_id,passport_id,platform_id,market,locale,'base',category_id,status,schema_version,payload_json,validation_json,created_at,updated_at FROM platform_drafts`),
          DB.prepare('DROP TABLE platform_drafts'),
          DB.prepare('ALTER TABLE platform_drafts_scene_migration RENAME TO platform_drafts'),
          DB.prepare('CREATE INDEX IF NOT EXISTS idx_drafts_task_platform ON platform_drafts(task_id, platform_id, market)'),
        ]);
      }
      const assetColumns = (await DB.prepare('PRAGMA table_info(generated_assets)').all<{ name: string }>()).results.map((column) => column.name);
      if (!assetColumns.includes('scene_id')) await DB.prepare("ALTER TABLE generated_assets ADD COLUMN scene_id TEXT NOT NULL DEFAULT 'base'").run();
      await DB.prepare('PRAGMA optimize').run();
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  await schemaPromise;
}
