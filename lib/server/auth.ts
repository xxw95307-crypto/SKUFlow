import { headers } from 'next/headers';
import { ensureSchema, getBindings } from '@/db/client';
import { identityFromHeaders, resourceReferences } from '@/lib/domain/identity';
import { accountFromSession, SESSION_COOKIE } from '@/lib/server/account-auth';

async function accountForHeaders(requestHeaders: Headers) {
  if (requestHeaders.get('cookie')?.includes(`${SESSION_COOKIE}=`)) {
    await ensureSchema();
    const account = await accountFromSession(requestHeaders, getBindings().DB);
    if (account) return account;
  }
  return identityFromHeaders(requestHeaders);
}

export async function currentAccount() {
  return accountForHeaders(new Headers(await headers()));
}

export function withAuthentication<T extends (...args: any[]) => Promise<Response>>(handler: T) {
  return async (...args: Parameters<T>): Promise<Response> => {
    const request = args[0] as Request;
    const user = await accountForHeaders(request.headers);
    if (!user) return Response.json({ error: '请先登录 SKUFlow', signInUrl: '/login' }, { status: 401, headers: { 'cache-control': 'no-store' } });
    const origin = request.headers.get('origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site')) {
      return Response.json({ error: '不允许跨站操作' }, { status: 403 });
    }
    try {
      await ensureSchema();
      const { DB, LEGACY_DATA_OWNER_EMAIL } = getBindings();
      // Import unowned historical demo records once, exclusively for the verified site owner.
      if (LEGACY_DATA_OWNER_EMAIL && user.email.toLowerCase() === LEGACY_DATA_OWNER_EMAIL.toLowerCase()) {
        const migration = await DB.prepare("SELECT completed FROM account_migrations WHERE id='legacy-owner'").first<{ completed: number }>();
        if (!migration?.completed) {
        await DB.batch([
          DB.prepare("INSERT INTO account_migrations (id,user_id,completed) VALUES ('legacy-owner',?,0) ON CONFLICT(id) DO NOTHING").bind(user.id),
          ...[['task', 'tasks'], ['conversation', 'agent_conversations']].map(([kind, table]) => DB.prepare(`INSERT INTO resource_owners (kind,resource_id,user_id) SELECT ?,id,? FROM ${table} WHERE EXISTS (SELECT 1 FROM account_migrations WHERE id='legacy-owner' AND user_id=? AND completed=0) ON CONFLICT(kind,resource_id) DO NOTHING`).bind(kind,user.id,user.id)),
          DB.prepare("UPDATE account_migrations SET completed=1 WHERE id='legacy-owner' AND user_id=?").bind(user.id),
        ]);
        }
      }
      let body: unknown = null;
      if (request.headers.get('content-type')?.includes('application/json')) {
        body = await request.clone().json().catch(() => null);
      }
      for (const ref of resourceReferences(request.url, body)) {
        const owned = await DB.prepare('SELECT 1 AS ok FROM resource_owners WHERE kind=? AND resource_id=? AND user_id=?').bind(ref.kind,ref.id,user.id).first();
        if (!owned) return Response.json({ error: '记录不存在或无权访问' }, { status: 404 });
      }
      const response = await handler(...args);
      response.headers.set('cache-control', 'private, no-store');
      response.headers.append('Vary', 'Cookie');
      return response;
    } catch (error) {
      console.error('Authenticated request failed', error);
      return Response.json({ error: '账号数据暂时无法读取，请稍后重试' }, { status: 503 });
    }
  };
}
