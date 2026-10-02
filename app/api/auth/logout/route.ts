import { ensureSchema, getBindings } from '@/db/client';
import { clearSessionCookie, requestAllowed, revokeSession } from '@/lib/server/account-auth';

export async function POST(request: Request) {
  if (!requestAllowed(request)) return Response.json({ error: '不允许跨站操作' }, { status: 403 });
  await ensureSchema();
  await revokeSession(getBindings().DB, request.headers);
  const response = Response.json({ ok: true });
  response.headers.set('Set-Cookie', clearSessionCookie(request.url));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
