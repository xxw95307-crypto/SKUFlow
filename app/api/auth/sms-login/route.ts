import { ensureSchema, getBindings } from '@/db/client';
import { checkPnvsCode, pnvsConfigured } from '@/lib/server/aliyun-pnvs';
import { beginSmsVerification, clientIp, finishSmsVerification, issueSession, limitAttempt, normalizePhone, requestAllowed, sha256 } from '@/lib/server/account-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!requestAllowed(request)) return Response.json({ error: '不允许跨站操作' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const phone = normalizePhone(body.phone);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!phone || !/^\d{6}$/.test(code)) return Response.json({ error: '手机号或验证码不正确' }, { status: 400 });
  const bindings = getBindings();
  if (!pnvsConfigured(bindings)) return Response.json({ error: '短信认证服务尚未配置' }, { status: 503 });
  await ensureSchema();
  const { DB } = bindings;
  if (!await limitAttempt(DB, `sms-login:${await sha256(`${clientIp(request)}:${phone}`)}`, 10, 900)) return Response.json({ error: '尝试过于频繁，请稍后再试' }, { status: 429 });
  const challengeId = await beginSmsVerification(DB, phone);
  if (!challengeId) return Response.json({ error: '验证码错误或已过期' }, { status: 401 });
  let verified: boolean;
  try { verified = await checkPnvsCode(bindings, phone, code); }
  catch { return Response.json({ error: '验证码核验服务暂时不可用，请稍后重试' }, { status: 502 }); }
  if (!verified || !await finishSmsVerification(DB, phone, challengeId)) return Response.json({ error: '验证码错误或已过期' }, { status: 401 });
  const existing = await DB.prepare('SELECT id FROM app_users WHERE phone=?').bind(phone).first<{ id: string }>();
  let id = existing?.id;
  if (!id) {
    id = `user_${crypto.randomUUID()}`;
    await DB.prepare('INSERT INTO app_users(id,username,phone,name,password_hash,created_at) VALUES (?,NULL,?,?,NULL,?) ON CONFLICT(phone) DO NOTHING')
      .bind(id, phone, `用户 ${phone.slice(-4)}`, new Date().toISOString()).run();
    id = (await DB.prepare('SELECT id FROM app_users WHERE phone=?').bind(phone).first<{ id: string }>())!.id;
  }
  const response = Response.json({ ok: true });
  response.headers.set('Set-Cookie', await issueSession(DB, id, request.url));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
