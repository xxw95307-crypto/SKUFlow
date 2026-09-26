import type { PlatformId } from '../domain/platform.ts';
import { amazonMarkets, findAmazonMarket } from './amazon-markets.ts';

export interface PlatformTarget { platformId: PlatformId; market: string }

const amazon = amazonMarkets.map(({ label }) => label);
const commonLocalizationMarkets = ['美国', '英国', '德国', '法国', '日本', '新加坡', '巴西'];

/** Markets exposed by SKUFlow's current adapters, not a claim that every seller is eligible. */
const platformMarkets: Record<PlatformId, readonly string[]> = {
  amazon,
  'tiktok-shop': ['美国', '英国', '德国', '法国', '意大利', '西班牙', '爱尔兰', '日本', '新加坡', '巴西', '墨西哥'],
  shopify: commonLocalizationMarkets,
  shopee: ['新加坡', '马来西亚', '泰国', '越南', '菲律宾', '印度尼西亚', '中国台湾', '巴西', '墨西哥'],
  lazada: ['新加坡', '马来西亚', '泰国', '越南', '菲律宾', '印度尼西亚'],
  ebay: ['美国', '英国', '德国', '法国', '西班牙', '意大利', '加拿大', '澳大利亚', '新加坡', '爱尔兰', '荷兰', '波兰', '比利时'],
  walmart: ['美国', '加拿大', '墨西哥'],
  etsy: commonLocalizationMarkets,
  aliexpress: commonLocalizationMarkets,
  temu: commonLocalizationMarkets,
  'mercado-libre': ['巴西', '墨西哥'],
  woocommerce: commonLocalizationMarkets,
};

export function marketOptionsForPlatform(platformId: PlatformId): readonly string[] {
  return platformMarkets[platformId];
}

export function normalizeMarket(market: string): string {
  return findAmazonMarket(market)?.label ?? market.trim();
}

export function validatePlatformTargets(targets: readonly PlatformTarget[]): PlatformTarget[] {
  if (!targets.length || targets.length > 24) throw new Error('请选择 1-24 个平台与站点组合');
  const seen = new Set<string>();
  return targets.map(({ platformId, market }) => {
    const normalized = normalizeMarket(market);
    if (!Object.prototype.hasOwnProperty.call(platformMarkets, platformId)) throw new Error(`不支持的平台：${platformId}`);
    if (!platformMarkets[platformId].includes(normalized)) throw new Error(`${platformId} 暂不支持选择 ${normalized}；请按平台重新选择站点`);
    const key = `${platformId}:${normalized}`;
    if (seen.has(key)) throw new Error(`重复的平台站点组合：${key}`);
    seen.add(key);
    return { platformId, market: normalized };
  });
}

export function targetsFromSharedSelection(platforms: readonly PlatformId[], markets: readonly string[]): PlatformTarget[] {
  if (platforms.length > 1 && markets.length > 1) throw new Error('多个平台和站点需要分别配对，请在选择卡中为每个平台选择站点');
  return validatePlatformTargets(platforms.flatMap((platformId) => markets.map((market) => ({ platformId, market }))));
}
