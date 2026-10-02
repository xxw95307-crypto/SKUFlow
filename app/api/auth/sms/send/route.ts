import { ensureSchema, getBindings } from '@/db/client';
import { smsConfigured, sendAliyunCode } from '@/lib/server/aliyun-sms';
import { authSecret, challengeHash, clientIp, limitAttempt, normalizePhone, requestAllowed, sha256 } from '@/lib/server/account-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!requestAllowed(request)) return Response.json({ error: '不允许跨站操作' }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const phone = normalizePhone(body.phone);
  if (!phone) return Response.json({ error: '请输入有效的中国大陆手机号' }, { status: 400 });
  const bindings = getBindings();
  const secret = authSecret(bindings);
  if (!secret || !smsConfigured(bindings)) return Response.json({ error: '短信登录尚未开通' }, { status: 503 });
  await ensureSchema();
  const { DB } = bindings;
  if (!await limitAttempt(DB, `sms-ip:${await sha256(clientIp(request))}`, 20, 3600)
    || !await limitAttempt(DB, `sms-phone:${await sha256(phone)}`, 5, 3600)) {
    return Response.json({ error: '验证码请求过于频繁，请稍后再试' }, { status: 429 });
  }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const hash = await challengeHash(secret, phone, code);
  const now = new Date();
  const cooldown = new Date(now.getTime() - 60_000).toISOString();
  const reserved = await DB.prepare(`INSERT INTO sms_challenges(phone,code_hash,expires_at,sent_at,attempts) VALUES (?,?,?,?,0)
    ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,sent_at=excluded.sent_at,attempts=0
    WHERE sms_challenges.sent_at<? RETURNING phone`)
    .bind(phone, hash, new Date(now.getTime() + 300_000).toISOString(), now.toISOString(), cooldown).first();
  if (!reserved) return Response.json({ error: '请等待 60 秒后再发送' }, { status: 429 });
  try {
    await sendAliyunCode(bindings, phone, code);
  } catch {
    await DB.prepare('DELETE FROM sms_challenges WHERE phone=? AND code_hash=?').bind(phone, hash).run();
    return Response.json({ error: '验证码发送失败，请稍后再试' }, { status: 502 });
  }
  return Response.json({ ok: true, retryAfter: 60 }, { headers: { 'Cache-Control': 'no-store' } });
}
