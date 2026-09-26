import type { ListingDraftPayload } from '../domain/listing.ts';
import { GENERATED_ASSET_KINDS, type GeneratedAsset, type GeneratedAssetKind } from '../domain/generated-asset.ts';
import type { PlatformId } from '../domain/platform.ts';
import type { ProductFact } from '../domain/product-passport.ts';

export const ASSET_PLAN_VERSION = 'dynamic-v2';
const ALLOWED_SIZES = ['1024*1024', '1024*1280', '1280*1024'] as const;

export interface AssetGenerationSpec {
  kind: GeneratedAssetKind;
  title: string;
  note: string;
  size: (typeof ALLOWED_SIZES)[number];
  instruction: string;
}

export interface AssetPlanningContext {
  productName: string;
  facts: readonly ProductFact[];
  listings: readonly ListingDraftPayload[];
  platforms: readonly PlatformId[];
  markets: readonly string[];
  sourceImageCount: number;
  sourceImageIds?: string[];
  userGuidance?: string | null;
}

function plainText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function factText(facts: readonly ProductFact[]): string {
  return facts.filter((fact) => fact.status !== 'MISSING').slice(0, 40).map((fact) => {
    const value = typeof fact.value === 'string' || typeof fact.value === 'number' || typeof fact.value === 'boolean'
      ? String(fact.value)
      : JSON.stringify(fact.value);
    return `${fact.label}：${value}${fact.unit ? ` ${fact.unit}` : ''}`;
  }).join('；');
}

function listingText(listings: readonly ListingDraftPayload[]): string {
  return listings.flatMap((listing) => Object.entries(listing.fields))
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .slice(0, 12)
    .map(([key, value]) => `${key}：${String(value).slice(0, 220)}`)
    .join('；');
}

export function buildAssetPlanningMessages(context: AssetPlanningContext): Array<{ role: 'system' | 'user'; content: string }> {
  return [{
    role: 'system',
    content: `你是跨境电商视觉策划 Agent。请根据商品类目、可信属性、已审核 Listing、目标平台和原图数量，规划最适合该商品的一组视觉素材，而不是套用固定场景。

只输出 JSON：{"assets":[{"kind":"HERO","title":"中文标题","note":"中文用途说明","size":"1024*1024","instruction":"给图像模型的中文生成指令"}]}。

这一阶段只规划图片，不规划、提交或生成视频。视频会在商家确认最终图片后单独处理。

规则：
0. 商家本轮要求优先于类目建议；明确排除的图类型或场景不得再次规划。例如“不要细节图”必须排除 DETAIL 与任何细节特写，改选其他有依据的素材。不把排除要求解释成仅调整细节图。
1. 总数由你判断，必须为 2–4 张；必须且只能有一张 HERO 商品主图。
2. 其他 kind 从 LIFESTYLE、DETAIL、MODEL、FEATURE、SCALE、PACKAGING 中选择，可按商品需要重复同一 kind，但场景和目的不得重复。
3. 服装可优先考虑 MODEL、穿搭场景和面料细节；家电可考虑使用场景、结构细节和尺寸感；食品可考虑包装、食用场景和质感特写。必须根据当前商品判断。
4. size 只能是 1024*1024、1024*1280 或 1280*1024。
5. instruction 必须明确构图、环境、镜头、光线和要突出的可信事实，并要求保持原商品身份一致。
6. 不得虚构功能、配件、认证、促销、尺寸或商品事实；不得要求生成价格、标题、角标、平台 Logo 或大段文字。
7. 如果资料不支持包装、模特、尺寸对照或使用方式，不要规划对应素材。
8. title、note 和 instruction 使用简体中文。`,
  }, {
    role: 'user',
    content: `商品名称：${context.productName}
已确认商品事实：${factText(context.facts) || '仅以原图可见内容为准'}
已审核 Listing：${listingText(context.listings) || '无'}
目标平台：${context.platforms.join('、') || '未指定'}
目标市场：${context.markets.join('、') || '未指定'}
可用原始商品图：${context.sourceImageCount} 张；可用原图ID：${(context.sourceImageIds ?? []).join("、")}
商家本轮补充要求：${plainText(context.userGuidance) || '无，由你根据商品与平台自主判断'}

请为这个具体商品制定素材计划。`,
  }];
}

export function parseAssetPlan(value: string): AssetGenerationSpec[] {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error('视觉策划 Agent 返回的 JSON 无法解析');
  }
  const candidates = raw && typeof raw === 'object' && Array.isArray((raw as { assets?: unknown }).assets)
    ? (raw as { assets: unknown[] }).assets
    : [];
  const assets: AssetGenerationSpec[] = [];
  for (const candidate of candidates.slice(0, 4)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const kind = plainText(record.kind).toUpperCase();
    const title = plainText(record.title).slice(0, 40);
    const note = plainText(record.note).slice(0, 120);
    const instruction = plainText(record.instruction).slice(0, 1_200);
    const size = plainText(record.size);
    if (!GENERATED_ASSET_KINDS.includes(kind as (typeof GENERATED_ASSET_KINDS)[number]) || !title || !note || !instruction) continue;
    if (!ALLOWED_SIZES.includes(size as AssetGenerationSpec['size'])) continue;
    assets.push({ kind: kind as GeneratedAssetKind, title, note, instruction, size: size as AssetGenerationSpec['size'] });
  }
  if (assets.length < 2 || assets.length > 4) throw new Error('视觉策划 Agent 必须规划 2–4 张素材');
  if (assets.filter((asset) => asset.kind === 'HERO').length !== 1) throw new Error('视觉策划 Agent 必须且只能规划一张商品主图');
  return assets;
}

export function selectConfirmedVideoImages(latestAssets: readonly GeneratedAsset[], requestedIds: unknown): GeneratedAsset[] {
  if (!Array.isArray(requestedIds) || requestedIds.length === 0 || requestedIds.length > 20
    || requestedIds.some((id) => typeof id !== 'string' || !/^asset_[\w-]+$/.test(id))) {
    throw new Error('请先确认最终图片，再生成视频');
  }
  const ids = [...new Set(requestedIds as string[])];
  if (ids.length !== requestedIds.length) throw new Error('已选图片列表不能重复');
  const byId = new Map(latestAssets.map((asset) => [asset.id, asset]));
  const images = ids.map((id) => byId.get(id));
  if (images.some((image) => !image || image.status !== 'COMPLETED' || image.kind === 'VIDEO')) {
    throw new Error('已选图片不属于当前可用素材，请重新确认图片');
  }
  return images as GeneratedAsset[];
}

export function buildAssetGenerationPrompt(input: {
  spec: AssetGenerationSpec;
  productName: string;
  facts: readonly ProductFact[];
  listings: readonly ListingDraftPayload[];
}): string {
  return `你是跨境电商商品摄影与视觉设计师。请以输入图片中的真实商品作为唯一主体，执行视觉策划 Agent 制定的单张素材任务。

强制要求：
1. 严格保持商品身份、外形、颜色、结构、材质、图案、商标和部件数量与参考图一致；不要把商品替换成相似款。
2. 去除参考截图中的 App 界面、价格、按钮、状态栏和无关文字；不要照搬水印。
3. 只能使用下方已确认商品事实，不得添加资料没有支持的配件、功能、认证、促销或文字。
4. 画面内不要生成标题、价格、卖点文字、角标或平台 Logo；后续会由排版工具另行添加。
5. 保持商业摄影质感、真实比例、自然光影和清晰细节。

商品名称：${input.productName}
已确认商品事实：${factText(input.facts) || '以参考图可见内容为准'}
已审核 Listing 语义参考：${listingText(input.listings) || '无'}

视觉策划任务：${input.spec.instruction}`;
}
