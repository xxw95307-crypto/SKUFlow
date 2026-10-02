import { getBindings } from '@/db/client';
import { pnvsConfigured } from '@/lib/server/aliyun-pnvs';

export const dynamic = 'force-dynamic';

export async function GET() {
  const bindings = getBindings();
  return Response.json({ sms: pnvsConfigured(bindings), wechat: Boolean(bindings.WECHAT_APP_ID && bindings.WECHAT_APP_SECRET) }, { headers: { 'Cache-Control': 'no-store' } });
}
