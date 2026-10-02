import { getBindings } from '@/db/client';
import { smsConfigured } from '@/lib/server/aliyun-sms';
import { authSecret } from '@/lib/server/account-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const bindings = getBindings();
  return Response.json({ sms: Boolean(authSecret(bindings) && smsConfigured(bindings)), wechat: Boolean(bindings.WECHAT_APP_ID && bindings.WECHAT_APP_SECRET) }, { headers: { 'Cache-Control': 'no-store' } });
}
