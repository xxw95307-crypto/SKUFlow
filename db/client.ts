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
  AMAZON_US_SELLER_ID?: string;
  AMAZON_SP_API_SANDBOX_CLIENT_ID?: string;
  AMAZON_SP_API_SANDBOX_CLIENT_SECRET?: string;
  AMAZON_SP_API_SANDBOX_REFRESH_TOKEN?: string;
  LEGACY_DATA_OWNER_EMAIL?: string;
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
      await DB.prepare('PRAGMA optimize').run();
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  await schemaPromise;
}
