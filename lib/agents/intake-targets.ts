import type { PlatformId } from '../domain/platform.ts';

export interface IntakeTargets {
  platforms: PlatformId[];
  markets: string[];
  platformSource: 'message' | 'missing';
  marketSource: 'message' | 'missing';
}

const platformMatchers: Array<[PlatformId, RegExp]> = [
  ['amazon', /amazon|亚马逊/i],
  ['tiktok-shop', /tiktok(?:\s*shop)?|抖音海外/i],
  ['shopify', /shopify/i],
  ['shopee', /shopee|虾皮/i],
  ['lazada', /lazada/i],
  ['ebay', /ebay/i],
  ['walmart', /walmart|沃尔玛/i],
  ['etsy', /etsy/i],
  ['aliexpress', /aliexpress|速卖通/i],
  ['temu', /temu/i],
  ['mercado-libre', /mercado\s*libre|美客多/i],
  ['woocommerce', /woocommerce/i],
];

const marketMatchers: Array<[string, RegExp]> = [
  ['美国', /美国|美区|美站|united\s*states|\b(?:us|usa)\b/i],
  ['英国', /英国|英区|英站|united\s*kingdom|\buk\b/i],
  ['德国', /德国|德区|德站|germany/i],
  ['日本', /日本|日区|日站|japan/i],
  ['新加坡', /新加坡|singapore/i],
  ['巴西', /巴西|brazil/i],
];

export function inferIntakeTargets(message: string): IntakeTargets {
  const matchedPlatforms = platformMatchers.filter(([, matcher]) => matcher.test(message)).map(([id]) => id);
  const matchedMarkets = marketMatchers.filter(([, matcher]) => matcher.test(message)).map(([market]) => market);
  return {
    platforms: matchedPlatforms,
    markets: matchedMarkets,
    platformSource: matchedPlatforms.length ? 'message' : 'missing',
    marketSource: matchedMarkets.length ? 'message' : 'missing',
  };
}
