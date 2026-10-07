import { currentAccount, withAuthentication } from '@/lib/server/auth';
import { getBindings } from '@/db/client';
import { parseShopPreferences } from '@/lib/domain/shop-preferences';
import { getShopPreferences, saveShopPreferences } from '@/lib/server/shop-preferences-store';

export const dynamic = 'force-dynamic';

async function handleGET() {
  const userId = (await currentAccount())!.id;
  return Response.json({ preferences: await getShopPreferences(getBindings().DB, userId) });
}

async function handlePUT(request: Request) {
  try {
    const raw = await request.json();
    const preferences = parseShopPreferences(raw);
    await saveShopPreferences(getBindings().DB, (await currentAccount())!.id, preferences);
    return Response.json({ preferences });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '偏好保存失败' }, { status: 400 });
  }
}

export const GET = withAuthentication(handleGET);
export const PUT = withAuthentication(handlePUT);
