import type { AppBindings } from '../../db/client.ts';
import type { AmazonUsSellerConnection } from './amazon-us-listings.ts';

export function missingAmazonUsConnection(bindings: Partial<AppBindings>): string[] {
  const required = {
    AMAZON_SP_API_CLIENT_ID: bindings.AMAZON_SP_API_CLIENT_ID,
    AMAZON_SP_API_CLIENT_SECRET: bindings.AMAZON_SP_API_CLIENT_SECRET,
    AMAZON_SP_API_REFRESH_TOKEN: bindings.AMAZON_SP_API_REFRESH_TOKEN,
    AMAZON_SELLER_ID: bindings.AMAZON_SELLER_ID || bindings.AMAZON_US_SELLER_ID,
  };
  return Object.entries(required).filter(([, value]) => !value?.trim()).map(([name]) => name);
}

/** Single authorized seller for the first live integration; never return this from an API route. */
export function loadAmazonUsConnection(bindings: Partial<AppBindings>): AmazonUsSellerConnection {
  const missing = missingAmazonUsConnection(bindings);
  if (missing.length) throw new Error(`尚未连接 Amazon 卖家：缺少 ${missing.join('、')}`);
  return {
    clientId: bindings.AMAZON_SP_API_CLIENT_ID!.trim(),
    clientSecret: bindings.AMAZON_SP_API_CLIENT_SECRET!.trim(),
    refreshToken: bindings.AMAZON_SP_API_REFRESH_TOKEN!.trim(),
    sellerId: (bindings.AMAZON_SELLER_ID || bindings.AMAZON_US_SELLER_ID)!.trim(),
  };
}
