import { env } from 'cloudflare:workers';
import { schemaStatements } from './schema';

export interface AppBindings {
  DB: D1Database;
  UPLOADS: R2Bucket;
  BAILIAN_API_KEY?: string;
  BAILIAN_BASE_URL?: string;
  BAILIAN_MODEL?: string;
  BAILIAN_VISION_API_KEY?: string;
  BAILIAN_VISION_BASE_URL?: string;
  BAILIAN_VISION_MODEL?: string;
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
