import { withAuthentication } from '@/lib/server/auth';
import { getBindings } from '@/db/client';
import { runAmazonUsSandboxSmoke } from '@/lib/platforms/amazon-us-sandbox';

export const dynamic = 'force-dynamic';

async function handlePOST() {
  const bindings = getBindings();
  const credentials = {
    clientId: bindings.AMAZON_SP_API_SANDBOX_CLIENT_ID?.trim() ?? '',
    clientSecret: bindings.AMAZON_SP_API_SANDBOX_CLIENT_SECRET?.trim() ?? '',
    refreshToken: bindings.AMAZON_SP_API_SANDBOX_REFRESH_TOKEN?.trim() ?? '',
  };
  if (!credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
    return Response.json({ error: '当前网站运行环境尚未配置 Amazon 沙箱凭据' }, { status: 503 });
  }
  try {
    const result = await runAmazonUsSandboxSmoke(credentials);
    return Response.json({ result });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : 'Amazon 沙箱调用失败',
    }, { status: 502 });
  }
}

export const POST = withAuthentication(handlePOST);
