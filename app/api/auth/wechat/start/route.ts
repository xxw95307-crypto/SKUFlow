import { getBindings } from '@/db/client';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const appId = getBindings().WECHAT_APP_ID?.trim();
  const appSecret = getBindings().WECHAT_APP_SECRET?.trim();
  if (!appId || !appSecret) return Response.redirect(new URL('/login?error=wechat-unavailable', request.url), 303);
  const state = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const redirectUri = new URL('/api/auth/wechat/callback', request.url);
  const authorize = new URL('https://open.weixin.qq.com/connect/qrconnect');
  authorize.searchParams.set('appid', appId);
  authorize.searchParams.set('redirect_uri', redirectUri.toString());
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'snsapi_login');
  authorize.searchParams.set('state', state);
  authorize.hash = 'wechat_redirect';
  const response = Response.redirect(authorize.toString(), 302);
  response.headers.set('Set-Cookie', `skuflow_wechat_state=${state}; Path=/api/auth/wechat; HttpOnly; SameSite=Lax; Max-Age=600${redirectUri.protocol === 'https:' ? '; Secure' : ''}`);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
