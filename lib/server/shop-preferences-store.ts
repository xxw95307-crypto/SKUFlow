import { parseShopPreferences, type ShopPreferences } from '../domain/shop-preferences.ts';

export async function getShopPreferences(DB: D1Database, userId: string): Promise<ShopPreferences | null> {
  const row = await DB.prepare('SELECT preferences_json, confirmed_at FROM shop_preferences WHERE user_id = ?')
    .bind(userId).first<{ preferences_json: string; confirmed_at: string }>();
  if (!row) return null;
  try { return parseShopPreferences(JSON.parse(row.preferences_json), row.confirmed_at); }
  catch { return null; }
}

export async function saveShopPreferences(DB: D1Database, userId: string, preferences: ShopPreferences): Promise<void> {
  await DB.prepare(`INSERT INTO shop_preferences (user_id,preferences_json,confirmed_at,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET preferences_json=excluded.preferences_json,confirmed_at=excluded.confirmed_at,updated_at=excluded.updated_at`)
    .bind(userId, JSON.stringify(preferences), preferences.confirmedAt, new Date().toISOString()).run();
}
