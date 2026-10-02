import { ensureSchema, getBindings } from '@/db/client';
import { issueSession, secureEqual } from '@/lib/server/account-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const cookieState = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('skuflow_wechat_state='))?.slice('skuflow_wechat_state='.length) || '';
  const clearState = `skuflow_wechat_state=; Path=/api/auth/wechat; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}`;
  const fail = () => {
    const response = Response.redirect(new URL('/login?error=wechat-failed', url), 303);
    response.headers.set('Set-Cookie', clearState);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
  if (!/^[0-9a-f]{64}$/.test(state) || !secureEqual(state, cookieState) || !code || code.length > 200) return fail();
  const { DB, WECHAT_APP_ID, WECHAT_APP_SECRET } = getBindings();
  if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) return fail();
  try {
    const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
    tokenUrl.searchParams.set('appid', WECHAT_APP_ID);
    tokenUrl.searchParams.set('secret', WECHAT_APP_SECRET);
    tokenUrl.searchParams.set('code', code);
    tokenUrl.searchParams.set('grant_type', 'authorization_code');
    const tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(10_000) });
    const token = await tokenResponse.json() as { access_token?: string; openid?: string; errcode?: number };
    if (!tokenResponse.ok || !token.openid || !token.access_token || token.errcode) return fail();
    await ensureSchema();
    let user = await DB.prepare("SELECT user_id FROM oauth_identities WHERE provider='wechat' AND subject=?")
      .bind(token.openid).first<{ user_id: string }>();
    if (!user) {
      let name = '微信用户';
      const profileUrl = new URL('https://api.weixin.qq.com/sns/userinfo');
      profileUrl.searchParams.set('access_token', token.access_token);
      profileUrl.searchParams.set('openid', token.openid);
      profileUrl.searchParams.set('lang', 'zh_CN');
      const profileResponse = await fetch(profileUrl, { signal: AbortSignal.timeout(10_000) });
      if (profileResponse.ok) {
        const profile = await profileResponse.json() as { nickname?: string };
        if (profile.nickname?.trim()) name = profile.nickname.trim().slice(0, 40);
      }
      const id = `user_${crypto.randomUUID()}`;
      await DB.prepare('INSERT INTO app_users(id,username,phone,name,password_hash,created_at) VALUES (?,NULL,NULL,?,NULL,?)')
        .bind(id, name, new Date().toISOString()).run();
      await DB.prepare("INSERT INTO oauth_identities(provider,subject,user_id,created_at) VALUES ('wechat',?,?,?) ON CONFLICT(provider,subject) DO NOTHING")
        .bind(token.openid, id, new Date().toISOString()).run();
      user = (await DB.prepare("SELECT user_id FROM oauth_identities WHERE provider='wechat' AND subject=?")
        .bind(token.openid).first<{ user_id: string }>())!;
      if (user.user_id !== id) await DB.prepare('DELETE FROM app_users WHERE id=?').bind(id).run();
    }
    const response = Response.redirect(new URL('/', url), 303);
    response.headers.append('Set-Cookie', clearState);
    response.headers.append('Set-Cookie', await issueSession(DB, user.user_id, request.url));
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch {
    return fail();
  }
}
