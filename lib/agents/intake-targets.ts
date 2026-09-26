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
  ['加拿大', /加拿大|canada/i],
  ['墨西哥', /墨西哥|mexico/i],
  ['爱尔兰', /爱尔兰|ireland/i],
  ['西班牙', /西班牙|spain/i],
  ['法国', /法国|france/i],
  ['比利时', /比利时|belgium/i],
  ['荷兰', /荷兰|netherlands/i],
  ['意大利', /意大利|italy/i],
  ['瑞典', /瑞典|sweden/i],
  ['南非', /南非|south\s*africa/i],
  ['波兰', /波兰|poland/i],
  ['埃及', /埃及|egypt/i],
  ['土耳其', /土耳其|turkey/i],
  ['沙特阿拉伯', /沙特阿拉伯|沙特|saudi\s*arabia/i],
  ['阿联酋', /阿联酋|united\s*arab\s*emirates/i],
  ['印度', /印度|india/i],
  ['澳大利亚', /澳大利亚|澳洲|australia/i],
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

// Only seller messages supply targeting; assistant suggestions and filenames
// are not seller choices. Later explicit choices replace earlier ones.
export function inferConversationTargets(messages: Array<{ role: string; content: string | null }>): IntakeTargets {
  let targets = inferIntakeTargets('');
  for (const message of messages) {
    if (message.role !== 'user' || !message.content) continue;
    const text = message.content.split('\n\n[本轮聊天附件：')[0];
    const next = inferIntakeTargets(text);
    // Ambiguous mentions are not confirmed choices. Ask again instead of
    // silently retaining a target that the seller may have rejected.
    if (/[?？]|不要|不选|不做|不想|取消|是否|哪个好|怎么样|区别|\b(?:not|instead|which)\b/i.test(text)) {
      if (next.platforms.length) { targets.platforms = []; targets.platformSource = 'missing'; }
      if (next.markets.length) { targets.markets = []; targets.marketSource = 'missing'; }
      continue;
    }
    targets = {
      platforms: next.platforms.length ? next.platforms : targets.platforms,
      markets: next.markets.length ? next.markets : targets.markets,
      platformSource: next.platforms.length ? 'message' : targets.platformSource,
      marketSource: next.markets.length ? 'message' : targets.marketSource,
    };
  }
  return targets;
}
