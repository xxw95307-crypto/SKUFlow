import { ensureSchema, getBindings } from '@/db/client';
import { clientIp, issueSession, limitAttempt, requestAllowed, sha256, verifyPassword, type AppUserRow } from '@/lib/server/account-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!requestAllowed(request)) return Response.json({ error: '不允许跨站操作' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const identifier = typeof body.identifier === 'string' ? body.identifier.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!identifier || !password || identifier.length > 50 || password.length > 128) return Response.json({ error: '用户名或密码不正确' }, { status: 401 });
  await ensureSchema();
  const { DB } = getBindings();
  if (!await limitAttempt(DB, `password:${await sha256(`${clientIp(request)}:${identifier}`)}`, 8, 900)) return Response.json({ error: '尝试过于频繁，请 15 分钟后再试' }, { status: 429 });
  const user = await DB.prepare('SELECT id,username,phone,name,password_hash FROM app_users WHERE username=? OR phone=?')
    .bind(identifier, identifier).first<AppUserRow>();
  if (!user || !await verifyPassword(password, user.password_hash)) return Response.json({ error: '用户名或密码不正确' }, { status: 401 });
  const response = Response.json({ ok: true });
  response.headers.set('Set-Cookie', await issueSession(DB, user.id, request.url));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
