import type { AccountIdentity } from '@/lib/domain/identity';
import type { AppBindings } from '@/db/client';

const encoder = new TextEncoder();
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'skuflow_session';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(length: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(length)));
}

export async function sha256(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export function secureEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function normalizePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const phone = value.trim().replace(/^\+86/, '');
  return /^1[3-9]\d{9}$/.test(phone) ? phone : null;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10 || password.length > 128) throw new Error('密码需要 10–128 个字符');
  const salt = randomHex(16);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: Uint8Array.from(salt.match(/../g)!, (part) => parseInt(part, 16)), iterations: 310_000, hash: 'SHA-256' }, key, 256);
  return `pbkdf2_sha256$310000$${salt}$${bytesToHex(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored || password.length > 128) return false;
  const [algorithm, rounds, salt, expected] = stored.split('$');
  if (algorithm !== 'pbkdf2_sha256' || rounds !== '310000' || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: Uint8Array.from(salt.match(/../g)!, (part) => parseInt(part, 16)), iterations: 310_000, hash: 'SHA-256' }, key, 256);
  return secureEqual(bytesToHex(new Uint8Array(bits)), expected);
}

export async function challengeHash(secret: string, phone: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${phone}:${code}`))));
}

export function authSecret(bindings: AppBindings): string | null {
  const value = bindings.AUTH_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

export function requestAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  return !((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site');
}

export async function limitAttempt(DB: D1Database, bucket: string, limit: number, seconds: number): Promise<boolean> {
  const now = new Date();
  const reset = new Date(now.getTime() + seconds * 1000).toISOString();
  const row = await DB.prepare(`INSERT INTO auth_rate_limits(bucket,attempts,reset_at) VALUES (?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,
    reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING attempts`)
    .bind(bucket, reset, now.toISOString(), now.toISOString()).first<{ attempts: number }>();
  return Boolean(row && row.attempts <= limit);
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

export async function consumeSmsCode(DB: D1Database, secret: string, phone: string, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const now = new Date().toISOString();
  const hash = await challengeHash(secret, phone, code);
  const row = await DB.prepare('UPDATE sms_challenges SET attempts=attempts+1 WHERE phone=? AND attempts<5 AND expires_at>? RETURNING code_hash')
    .bind(phone, now).first<{ code_hash: string }>();
  if (!row || !secureEqual(row.code_hash, hash)) return false;
  const consumed = await DB.prepare('DELETE FROM sms_challenges WHERE phone=? AND code_hash=? RETURNING phone').bind(phone, hash).first();
  return Boolean(consumed);
}

export interface AppUserRow { id: string; username: string | null; phone: string | null; name: string; password_hash: string | null }

export function accountFromUser(user: AppUserRow): AccountIdentity {
  return { id: user.id, name: user.name, email: '', ...(user.username ? { username: user.username } : {}), ...(user.phone ? { phone: user.phone } : {}), provider: 'local' };
}

export async function accountFromSession(headers: Headers, DB: D1Database): Promise<AccountIdentity | null> {
  const token = headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = await sha256(token);
  const user = await DB.prepare(`SELECT u.id,u.username,u.phone,u.name,u.password_hash FROM app_sessions s JOIN app_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).bind(hash, new Date().toISOString()).first<AppUserRow>();
  return user ? accountFromUser(user) : null;
}

export async function issueSession(DB: D1Database, userId: string, requestUrl: string): Promise<string> {
  const token = randomHex(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await DB.prepare('INSERT INTO app_sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .bind(await sha256(token), userId, expires.toISOString(), now.toISOString()).run();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${new URL(requestUrl).protocol === 'https:' ? '; Secure' : ''}`;
}

export async function revokeSession(DB: D1Database, headers: Headers): Promise<void> {
  const token = headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (token && /^[0-9a-f]{64}$/.test(token)) await DB.prepare('DELETE FROM app_sessions WHERE token_hash=?').bind(await sha256(token)).run();
}

export function clearSessionCookie(requestUrl: string): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${new URL(requestUrl).protocol === 'https:' ? '; Secure' : ''}`;
}
