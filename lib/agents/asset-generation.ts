import type { ListingDraftPayload } from '../domain/listing.ts';
import { GENERATED_ASSET_KINDS, type GeneratedAsset, type GeneratedAssetKind } from '../domain/generated-asset.ts';
import type { PlatformId } from '../domain/platform.ts';
import type { ProductFact } from '../domain/product-passport.ts';

export const ASSET_PLAN_VERSION = 'dynamic-v3';
const ALLOWED_SIZES = ['1024*1024', '1024*1280', '1280*1024'] as const;

export interface AssetGenerationSpec {
  kind: GeneratedAssetKind;
  title: string;
  note: string;
  size: (typeof ALLOWED_SIZES)[number];
  instruction: string;
  acceptance: string;
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
  requestedCount?: number | null;
  styleGuidance?: string | null;
  existingAssets?: readonly Pick<GeneratedAsset, 'kind' | 'title' | 'note'>[];
  targetIndices?: readonly number[];
}

export interface VisualToolDecision {
  scope: 'FULL_SET' | 'SELECTED';
  count: number | null;
  style: string | null;
  targetIndices: number[];
}

export function parseVisualToolDecision(argumentsJson: string, existingImageCount: number): VisualToolDecision {
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsJson); } catch { throw new Error('Agent 返回的图片操作参数不是有效 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Agent 返回的图片操作参数无效');
  const options = parsed as Record<string, unknown>;
  if (options.scope !== 'FULL_SET' && options.scope !== 'SELECTED') throw new Error('Agent 未明确图片操作范围，请重新描述要修改哪些图片');
  const style = options.style == null ? null : typeof options.style === 'string' && options.style.trim().length <= 200 ? options.style.trim() || null : undefined;
  if (style === undefined) throw new Error('Agent 返回的图片风格参数无效');
  if (options.scope === 'FULL_SET') {
    if (options.targetIndices != null && (!Array.isArray(options.targetIndices) || options.targetIndices.length > 0)) throw new Error('整组生成不能指定局部图片序号');
    if (options.count != null && (!Number.isInteger(options.count) || (options.count as number) < 1 || (options.count as number) > 6)) throw new Error('图片数量需为 1–6 张');
    return { scope: 'FULL_SET', count: options.count == null ? null : options.count as number, style, targetIndices: [] };
  }
  if (options.count != null) throw new Error('局部修改不能同时改变图片总数');
  if (!Array.isArray(options.targetIndices) || options.targetIndices.length < 1 || options.targetIndices.length > existingImageCount
    || options.targetIndices.some((index) => !Number.isInteger(index) || index < 1 || index > existingImageCount)
    || new Set(options.targetIndices).size !== options.targetIndices.length) {
    throw new Error('Agent 指定的图片序号无效，请重新指出要修改的图片');
  }
  return { scope: 'SELECTED', count: null, style, targetIndices: [...options.targetIndices].sort((a, b) => a - b) };
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
  const targeted = Boolean(context.targetIndices?.length);
  return [{
    role: 'system',
    content: `你是跨境电商视觉策划 Agent。根据商家本轮自然语言要求、已有图片和可信商品事实，自由规划这一轮要生成的商品图片。商家要求是唯一的创作目标，不套用固定图种组合。

只输出 JSON：{"assets":[{"kind":"CUSTOM","title":"中文标题","note":"中文用途说明","size":"1024*1024","instruction":"给图像模型的详细中文生成指令","acceptance":"该图完成后可从画面判断的具体验收标准"}]}。

这一阶段只规划图片，不规划、提交或生成视频。视频会在商家确认最终图片后单独处理。

规则：
0. 先把商家本轮要求拆成每一张独立的视觉任务，再逐项落实数量、内容、人物、风格、背景、角度、排除项和指定图片的要求。每张的 instruction 只能描述这一张的目标，不得混入其他图片的目标。例如“一张海报、一张模特图”应有两个可辨认且不同的画面形式，不能都只是模特场景照。本轮明确提出的要求覆盖旧图的风格和早先的偏好；旧图只用于理解商品或定位修改对象，不得从中继承排除项。明确不需要的元素绝不加入；商家没有要求的模特、主图、细节图等绝不作为必需项补入。
1. ${targeted ? `本轮只修改第 ${context.targetIndices!.join('、')} 张。只输出 ${context.targetIndices!.length} 个 assets，与这些序号依次对应。其余图片保持原样。` : `生成整组图片。${context.requestedCount == null ? '未指定数量时由你根据本轮要求决定 1–6 张；若自然语言明确列出了若干张，按列出的张数生成。' : `严格生成 ${context.requestedCount} 张。`}`}
2. kind 只是可选展示标签，可用 HERO、LIFESTYLE、DETAIL、MODEL、FEATURE、SCALE、PACKAGING、POSTER；不贴切时用 CUSTOM。不得让标签反过来限制商家需求。封面和顺序由后续 Agent 决定，本阶段不指定主图。
3. instruction 应描述每张图的主体、动作或摆放、构图、场景、光线、风格和必须避免的元素；acceptance 要把本轮要求转成视觉上可核对的标准，不得只写“符合要求”。当商家用不同名称指定多张时，验收标准必须能区分各张的画面形式，不能只检查商品或背景。若要求海报，验收要检查可辨认的海报设计构图、视觉层次与可用信息区域，普通人物场景照不能充当海报；是否有人物仍以商家要求为准。禁止把本轮商家明确要求出现的元素写进排除项；任何额外排除项都必须有本轮原话或商品事实支持。
4. size 只能是 1024*1024、1024*1280 或 1280*1024。
5. 商品身份、外形、颜色、结构、材质和真实标识必须与原图及已确认事实一致；不得虚构功能、配件、认证、促销或价格。海报文字仅可使用已确认事实，难以可靠生成时预留排版空间。
6. title、note、instruction、acceptance 使用简体中文。`,
  }, {
    role: 'user',
    content: `商品名称：${context.productName}
已确认商品事实：${factText(context.facts) || '仅以原图可见内容为准'}
已审核 Listing：${listingText(context.listings) || '无'}
目标平台：${context.platforms.join('、') || '未指定'}
目标市场：${context.markets.join('、') || '未指定'}
可用原始商品图：${context.sourceImageCount} 张；可用原图ID：${(context.sourceImageIds ?? []).join("、")}
当前图片（从 1 开始）：${context.existingAssets?.map((asset, index) => `${index + 1}. ${asset.kind}｜${asset.title}｜${asset.note}`).join('；') || '暂无'}
本轮只修改：${targeted ? context.targetIndices!.map((index) => `第 ${index} 张`).join('、') : '未指定，生成整组'}
商家本轮补充要求：${plainText(context.userGuidance) || '无，由你根据商品与平台自主判断'}
商家指定图片数量：${targeted ? '局部修改，不改变总张数' : context.requestedCount == null ? '未指定，由你判断' : `${context.requestedCount} 张，必须严格遵守`}
商家指定图片风格：${plainText(context.styleGuidance) || '未指定，由你根据商品与平台自主判断'}

请为这个具体商品制定素材计划。`,
  }];
}

export function parseAssetPlan(value: string, requestedCount?: number | null, targetIndices?: readonly number[]): AssetGenerationSpec[] {
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
  for (const candidate of candidates.slice(0, 6)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const kind = plainText(record.kind).toUpperCase();
    const title = plainText(record.title).slice(0, 40);
    const note = plainText(record.note).slice(0, 120);
    const instruction = plainText(record.instruction).slice(0, 1_200);
    const acceptance = plainText(record.acceptance).slice(0, 500);
    const size = plainText(record.size);
    if (!GENERATED_ASSET_KINDS.includes(kind as (typeof GENERATED_ASSET_KINDS)[number]) || !title || !note || !instruction || !acceptance) continue;
    if (!ALLOWED_SIZES.includes(size as AssetGenerationSpec['size'])) continue;
    assets.push({ kind: kind as GeneratedAssetKind, title, note, instruction, acceptance, size: size as AssetGenerationSpec['size'] });
  }
  if (targetIndices?.length) {
    if (assets.length !== targetIndices.length || candidates.length !== targetIndices.length) throw new Error(`视觉策划 Agent 必须只规划指定的 ${targetIndices.length} 张图片`);
    return assets;
  }
  if (requestedCount != null) {
    if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 6) throw new Error('图片数量需为 1–6 张');
    if (assets.length !== requestedCount || candidates.length !== requestedCount) throw new Error(`视觉策划 Agent 必须按商家要求规划 ${requestedCount} 张图片`);
  } else if (assets.length < 1 || assets.length > 6) throw new Error('视觉策划 Agent 应根据商家要求规划 1–6 张图片');
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
  previousAsset?: Pick<GeneratedAsset, 'title' | 'note' | 'kind'> | null;
}): string {
  return `你是跨境电商商品摄影与视觉设计师。${input.previousAsset ? '输入图片是本轮要修改的旧图。只修改这张图，严格执行商家的新要求；保留商品身份，无须复刻旧图的背景和构图。' : '请以输入图片中的真实商品作为唯一主体，执行视觉策划 Agent 制定的单张素材任务。'}

强制要求：
1. 严格保持商品身份、外形、颜色、结构、材质、图案、商标和部件数量与参考图一致；不要把商品替换成相似款。
2. 去除参考截图中的 App 界面、价格、按钮、状态栏和无关文字；不要照搬水印。
3. 只能使用下方已确认商品事实，不得添加资料没有支持的配件、功能、认证、促销或文字。
4. 只执行下方这一张的视觉任务与验收标准，绝不同时制作同组其他图片的形式。不要自行添加这张任务未要求的人物、文字、道具或场景。若任务需要海报文字，只使用已确认的商品名称或事实，不能可靠生成时预留排版空间。
5. 按这张图要求的媒介表达：摄影图保持真实比例和自然光影；海报、插画或信息设计应呈现清晰的设计构图、视觉层次和可用排版区域，不能只把普通场景照片当成设计成品。商品本身保持清晰。

商品名称：${input.productName}
已确认商品事实：${factText(input.facts) || '以参考图可见内容为准'}
已审核 Listing 语义参考：${listingText(input.listings) || '无'}
${input.previousAsset ? `待修改旧图：${input.previousAsset.kind}｜${input.previousAsset.title}｜${input.previousAsset.note}` : ''}

本张图片的视觉类型：${input.spec.kind}
本张图片的标题：${input.spec.title}
本张图片的用途：${input.spec.note}
视觉策划任务：${input.spec.instruction}
成图验收标准：${input.spec.acceptance}`;
}
