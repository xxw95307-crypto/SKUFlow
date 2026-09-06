import type { ListingDraftPayload } from '../domain/listing';
import type { GeneratedAssetKind } from '../domain/generated-asset';
import type { ProductFact } from '../domain/product-passport';

export interface AssetGenerationSpec {
  kind: GeneratedAssetKind;
  title: string;
  note: string;
  size: string;
  instruction: string;
}

export const ASSET_GENERATION_SPECS: readonly AssetGenerationSpec[] = [
  {
    kind: 'HERO',
    title: '平台商品主图',
    note: '干净、完整地呈现商品本体，适合作为 Listing 首图候选',
    size: '1024*1024',
    instruction: '制作一张高端电商商品主图：纯净浅色背景，商品居中完整展示，柔和棚拍光线，轮廓清晰，有自然接触阴影。',
  },
  {
    kind: 'LIFESTYLE',
    title: '生活方式场景图',
    note: '表达真实使用情境和商品氛围，不虚构未确认功能',
    size: '1024*1280',
    instruction: '制作一张真实自然的生活方式场景图：把同一商品放入符合其用途的日常环境，构图克制，商品仍是视觉主体。',
  },
  {
    kind: 'DETAIL',
    title: '材质与细节图',
    note: '突出资料中已确认的材质、结构或工艺细节',
    size: '1024*1024',
    instruction: '制作一张商品细节展示图：用近景和局部特写突出可被原图或商品事实支持的材质、结构与工艺，画面专业清晰。',
  },
] as const;

function factText(facts: readonly ProductFact[]): string {
  return facts.filter((fact) => fact.status !== 'MISSING').slice(0, 30).map((fact) => {
    const value = typeof fact.value === 'string' || typeof fact.value === 'number' || typeof fact.value === 'boolean'
      ? String(fact.value)
      : JSON.stringify(fact.value);
    return `${fact.label}：${value}${fact.unit ? ` ${fact.unit}` : ''}`;
  }).join('；');
}

function listingText(listings: readonly ListingDraftPayload[]): string {
  return listings.flatMap((listing) => Object.entries(listing.fields))
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .slice(0, 8)
    .map(([key, value]) => `${key}：${String(value).slice(0, 240)}`)
    .join('；');
}

export function buildAssetGenerationPrompt(input: {
  spec: AssetGenerationSpec;
  productName: string;
  facts: readonly ProductFact[];
  listings: readonly ListingDraftPayload[];
}): string {
  return `你是跨境电商商品摄影与视觉设计师。请以输入图片中的真实商品作为唯一主体，生成新的电商视觉素材。

强制要求：
1. 严格保持商品身份、外形、颜色、结构、材质、图案、商标和部件数量与参考图一致；不要把商品替换成相似款。
2. 去除参考截图中的 App 界面、价格、按钮、状态栏和无关文字；不要照搬水印。
3. 只能使用下方已确认商品事实，不得添加资料没有支持的配件、功能、认证、促销或文字。
4. 画面内不要生成标题、价格、卖点文字、角标或平台 Logo；后续会由排版工具另行添加。
5. 保持商业摄影质感、真实比例、自然光影和清晰细节。

商品名称：${input.productName}
已确认商品事实：${factText(input.facts) || '以参考图可见内容为准'}
已审核 Listing 语义参考：${listingText(input.listings) || '无'}

本张素材任务：${input.spec.instruction}`;
}
