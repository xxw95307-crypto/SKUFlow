import { runAmazonUsSandboxSmoke } from '../lib/platforms/amazon-us-sandbox.ts';

const credentials = {
  clientId: process.env.AMAZON_SP_API_SANDBOX_CLIENT_ID ?? '',
  clientSecret: process.env.AMAZON_SP_API_SANDBOX_CLIENT_SECRET ?? '',
  refreshToken: process.env.AMAZON_SP_API_SANDBOX_REFRESH_TOKEN ?? '',
};

try {
  const result = await runAmazonUsSandboxSmoke(credentials);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Amazon 沙箱测试失败');
  process.exitCode = 1;
}
