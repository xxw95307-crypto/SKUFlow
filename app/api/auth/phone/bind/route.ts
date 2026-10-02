import { ensureSchema, getBindings } from '@/db/client';
import { currentAccount } from '@/lib/server/auth';
import { checkPnvsCode, pnvsConfigured } from '@/lib/server/aliyun-pnvs';
import { beginSmsVerification, clientIp, finishSmsVerification, limitAttempt, normalizePhone, requestAllowed, sha256 } from '@/lib/server/account-auth';

export async function POST(request: Request) {
  if (!requestAllowed(request)) return Response.json({ error: '不允许跨站操作' }, { status: 403 });
  const account = await currentAccount();
  if (!account || account.provider !== 'local') return Response.json({ error: '请先登录 SKUFlow 账号' }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const phone = normalizePhone(body.phone);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!phone || !/^\d{6}$/.test(code)) return Response.json({ error: '手机号或验证码不正确' }, { status: 400 });
  const bindings = getBindings();
  if (!pnvsConfigured(bindings)) return Response.json({ error: '短信认证服务尚未配置' }, { status: 503 });
  await ensureSchema();
  const { DB } = bindings;
  if (!await limitAttempt(DB, `phone-bind:${await sha256(`${clientIp(request)}:${account.id}`)}`, 10, 900)) return Response.json({ error: '尝试过于频繁，请稍后再试' }, { status: 429 });
  const challengeId = await beginSmsVerification(DB, phone);
  if (!challengeId) return Response.json({ error: '验证码错误或已过期' }, { status: 401 });
  let verified: boolean;
  try { verified = await checkPnvsCode(bindings, phone, code); }
  catch { return Response.json({ error: '验证码核验服务暂时不可用，请稍后重试' }, { status: 502 }); }
  if (!verified || !await finishSmsVerification(DB, phone, challengeId)) return Response.json({ error: '验证码错误或已过期' }, { status: 401 });
  try {
    const row = await DB.prepare('UPDATE app_users SET phone=? WHERE id=? AND phone IS NULL RETURNING id').bind(phone, account.id).first();
    if (!row) return Response.json({ error: '该账号已经绑定手机号' }, { status: 409 });
  } catch {
    return Response.json({ error: '手机号已被其他账号使用' }, { status: 409 });
  }
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
