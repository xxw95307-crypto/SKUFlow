import { ensureSchema, getBindings } from '@/db/client';
import { clientIp, hashPassword, issueSession, limitAttempt, requestAllowed, sha256 } from '@/lib/server/account-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!requestAllowed(request)) return Response.json({ error: '不允许跨站操作' }, { status: 403 });
  const { DB } = getBindings();
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[a-z][a-z0-9_]{3,29}$/.test(username)) return Response.json({ error: '用户名需为 4–30 位英文字母、数字或下划线，且以字母开头' }, { status: 400 });
  if (password.length < 10 || password.length > 128) return Response.json({ error: '密码需要 10–128 个字符' }, { status: 400 });
  await ensureSchema();
  if (!await limitAttempt(DB, `register:${await sha256(clientIp(request))}`, 10, 3600)) return Response.json({ error: '尝试过于频繁，请稍后再试' }, { status: 429 });
  const hash = await hashPassword(password);
  const id = `user_${crypto.randomUUID()}`;
  try {
    await DB.prepare('INSERT INTO app_users(id,username,phone,name,password_hash,created_at) VALUES (?,?,NULL,?,?,?)')
      .bind(id, username, username, hash, new Date().toISOString()).run();
  } catch {
    return Response.json({ error: '用户名已被使用' }, { status: 409 });
  }
  const response = Response.json({ ok: true });
  response.headers.set('Set-Cookie', await issueSession(DB, id, request.url));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
