import type { AgentModelMessage, AgentToolDefinition, AgentToolName, AgentWorkflowState } from '../domain/agent-orchestrator.ts';
import { inferIntakeTargets } from './intake-targets.ts';

export function compactAgentModelHistory(messages: AgentModelMessage[], limit = 40): AgentModelMessage[] {
  if (messages.length <= limit) return [...messages];
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex < 0) return [];
  const currentTurn = messages.slice(lastUserIndex);
  if (currentTurn.length >= limit) {
    const tail = currentTurn.slice(-(limit - 1));
    while (tail[0]?.role === 'tool') tail.shift();
    return [currentTurn[0], ...tail];
  }
  const earlier = messages.slice(0, lastUserIndex)
    .filter((message) => message.role === 'user' || (message.role === 'assistant' && !message.toolCalls?.length))
    .slice(-(limit - currentTurn.length));
  while (earlier.length > 0 && earlier[0]?.role !== 'user') earlier.shift();
  return [...earlier, ...currentTurn];
}

export function requiredMediaToolAfterUser(messages: AgentModelMessage[]): AgentToolName | null {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex < 0) return null;
  const lastUser = messages[lastUserIndex];
  if (lastUser.role !== 'user') return null;
  const completed = new Set(messages.slice(lastUserIndex + 1).filter((message) => message.role === 'tool').map((message) => message.role === 'tool' ? message.name : ''));
  if (lastUser.content.startsWith('我已确认图片生成需求，请生成图片')) {
    if (completed.has('open_asset_selection')) return null;
    return completed.has('generate_visual_assets') ? 'open_asset_selection' : 'generate_visual_assets';
  }
  if (lastUser.content.includes('我已确认最终图片，请根据这些图片生成视频')) return 'generate_product_video';
  if (lastUser.content.includes('图片与视频阶段已完成，请进入最终交付确认') || lastUser.content.includes('我已确认图片，本次不需要视频，请进入最终交付确认')) return 'open_publish_confirmation';
  return null;
}

const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  inspect_chat_attachments: '读取本轮聊天附件并返回可供回答的文档内容、表格内容或图片理解结果。仅当用户是在询问、总结或核对附件，而不是要求创建商品上新任务时调用。',
  create_listing_task_from_attachments: '把本轮聊天附件保存为新的商品上新任务。仅当用户明确要求上新，并且已经在消息中明确指定至少一个平台和一个目标市场/站点时调用；不得使用默认平台或默认站点。',
  start_listing_workflow: '仅在用户有上新意图且仍缺少必要信息时，展示只包含缺失项的对话卡。结合本会话此前的选择和附件；已有资料无需重传，目标和资料齐全时直接创建任务。',
  parse_product_sources: '解析当前任务中的图片、PDF、表格和文本资料，形成统一内容块。',
  analyze_product_images: '调用当前百炼多模态模型读取全部商品实物图，提取可见属性和视觉证据。',
  merge_product_facts: '调用商品事实 Agent 合并文档与图片证据，生成统一商品属性并识别图文冲突。',
  open_scene_plan: '在生成 Listing 之前询问商家：常规上新，还是为同一商品制作多套不同场景的图片与文案；商家选择裂变套数后才继续。',
  open_target_selection: '打开当前任务的平台与站点选择卡，让商家重新选择。保留商品资料和事实；保存新目标后作废旧 Listing 审校稿。',
  update_task_targets: '更新当前商品任务的目标平台和目标市场/站点。仅在任务存在且尚未发布任何草稿时可调用。必须用户提供完整的平台列表和目标市场列表后才调用；不完整时先用自然语言询问。更新会作废旧的 Listing 审校稿，后续按新目标重新生成；图文冲突与商品事实不受影响。',
  reparse_sources: '强制重新解析当前任务的全部资料（图片、PDF、表格、文本），覆盖旧的解析结果。仅当用户明确要求重新解析，或说明资料有问题（如识别错漏、文件内容更新）时调用；任务存在且有资料、未发布即可调用。完成后应按需继续重新理解图片、重新合并事实；旧审校稿已作废。',
  reanalyze_images: '强制重新理解当前任务的全部商品实物图，覆盖旧的图片分析结果。仅当用户明确要求重新看图、重新识别图片属性，或图片理解结果有误时调用；任务存在且有图片、未发布即可调用。完成后应重新合并事实；旧审校稿已作废。',
  reopen_resolved_conflicts: '把全部已裁决或已忽略的图文冲突重置为待确认，让商家重新逐项选择。仅当用户明确要求重新裁决冲突、修改之前的冲突选择时调用；存在已裁决冲突且未发布即可调用。事实当前取值不变，直到商家重新选择；旧审校稿已作废。',
  generate_platform_listings: '读取所选平台字段（Shopify 使用真实接口），并由 Listing Agent 生成各平台中文审校稿。',
  open_conflict_review: '暂停自动执行，并在对话流中逐项询问商家如何处理图文冲突；不得打开遮罩弹窗。',
  open_listing_review: '暂停自动执行并向商家展示各平台中文 Listing 审核界面。',
  generate_visual_assets: '当商家要求生成或修改图片时启动视觉流程。图片操作范围、数量、人物和风格由专门的图片需求分析 Agent 从本轮自然语言判断；本工具无需填写参数，不得套用默认图种或触发视频模型。',
  generate_product_video: '商家确认最终图片并要求视频时，准备一份可编辑的视频提示词草稿，等待商家确认后才调用视频模型。',
  revise_product_video: '依据已选图片、上一条视频方案和商家本轮要求重新准备可编辑的视频提示词；仅修改视频时使用，保留已有图片，等待商家确认后才调用视频模型。',
  trim_product_video: '自动裁剪已有视频并返回结果，不展示裁剪卡、时间输入或操作按钮，不调用生成模型、不重做图片。中央Agent根据用户的大致时间和视频时长决定start/end（秒）。videoId必须引用可信视频ID。仅目标视频确实无法判断时先自然语言询问。',
  open_asset_selection: '向商家展示已经真实生成并保存的候选图片，让商家确认最终图片，再进入视频阶段。',
  revise_media_order: '仅在图片与视频选择完成后，按商家本轮自然语言要求重新规划封面或图片／视频顺序；不重新生成图片或视频。',
  open_publish_confirmation: '展示最终发布确认卡；调用此工具不会发布。',
  publish_mock_drafts: '在商家明确确认后创建平台测试草稿：Shopify 使用官方 Dev Store API 创建未公开 DRAFT，其他平台暂时使用本地 Mock。',
};

function tool(name: AgentToolName): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: TOOL_DESCRIPTIONS[name],
      parameters: {
        type: 'object',
        properties: name === 'trim_product_video'
          ? { videoId:{type:'string',description:'要裁剪的可信视频ID；不确定则省略'},start:{type:'number',description:'Agent决定的保留起点秒数；省略为0'},end:{type:'number',description:'Agent决定的保留终点秒数；省略为原视频终点'} }
          : name === 'update_task_targets'
            ? {
                platforms: { type: 'array', items: { type: 'string' }, description: '完整的目标平台 ID 列表（替换现有全部平台），如 ["amazon","tiktok-shop"]' },
                markets: { type: 'array', items: { type: 'string' }, description: '完整的目标市场/站点列表（替换现有全部市场），如 ["US","JP"]' },
              }
            : {},
        additionalProperties: false,
      },
    },
  };
}

export function availableAgentTools(state: AgentWorkflowState): AgentToolDefinition[] {
  if (!state.taskId) {
    const names: AgentToolName[] = [];
    if (state.pendingAttachmentCount > 0) names.push('inspect_chat_attachments', 'create_listing_task_from_attachments');
    names.push('start_listing_workflow');
    return names.map(tool);
  }
  const names: AgentToolName[] = [];
  const parsingReady = state.fileCount > 0 && state.parsedFileCount >= state.fileCount;
  const visionReady = state.imageCount === 0 || state.analyzedImageCount >= state.imageCount;
  const allDraftsApproved = state.draftCount > 0 && state.approvedDraftCount >= state.draftCount;
  const selectedImageCount = state.selectedImageCount ?? state.selectedAssetCount;
  const videoJobCount = state.videoJobCount ?? 0;

  if (!parsingReady) names.push('parse_product_sources');
  if (parsingReady && !visionReady) names.push('analyze_product_images');
  if (parsingReady && visionReady && state.publishedDraftCount === 0) names.push('merge_product_facts');
  if (state.openConflictCount > 0) names.push('open_conflict_review');
  if (state.factCount > 0 && state.openConflictCount === 0 && state.draftCount > 0 && !state.scenePlanConfirmed && state.generatedDraftCount === 0 && state.publishedDraftCount === 0) names.push('open_scene_plan');
  if (state.factCount > 0 && state.openConflictCount === 0 && state.draftCount > 0 && state.scenePlanConfirmed && state.generatedDraftCount < state.draftCount && state.publishedDraftCount === 0) {
    names.push('generate_platform_listings');
  }
  if (state.draftCount > 0 && state.generatedDraftCount === state.draftCount && !allDraftsApproved) names.push('open_listing_review');
  if (allDraftsApproved && state.publishedDraftCount === 0 && !state.publishApproved) names.push('generate_visual_assets');
  if (allDraftsApproved && state.imagesConfirmed && selectedImageCount > 0 && videoJobCount === 0 && !state.videoStageComplete && state.publishedDraftCount === 0 && !state.publishApproved) names.push('generate_product_video');
  if (allDraftsApproved && state.imagesConfirmed && selectedImageCount > 0 && videoJobCount > 0 && state.publishedDraftCount === 0 && !state.publishApproved) names.push('revise_product_video');
  if (allDraftsApproved && state.publishedDraftCount === 0 && state.generatedAssetCount > 0 && !state.imagesConfirmed) names.push('open_asset_selection');
  if (allDraftsApproved && state.publishedDraftCount === 0 && state.imagesConfirmed && selectedImageCount > 0 && state.videoStageComplete && !state.publishApproved) {
    names.push('revise_media_order');
    names.push('open_publish_confirmation');
  }
  if (allDraftsApproved && state.publishedDraftCount < state.draftCount && state.imagesConfirmed && selectedImageCount > 0 && state.videoStageComplete && state.publishApproved) {
    names.push('publish_mock_drafts');
  }
  if (allDraftsApproved && state.publishedDraftCount === 0 && !state.publishApproved && state.videoCandidates?.length) names.push('trim_product_video');
  return [...new Set(names)].map(tool);
}

export function restrictIntakeToolsForListingRequest(
  tools: AgentToolDefinition[],
  state: AgentWorkflowState,
  requestText: string,
): AgentToolDefinition[] {
  if (state.taskId || state.pendingAttachmentCount === 0) return tools;
  const targets = inferIntakeTargets(requestText);
  const hasExplicitTargets = targets.platformSource === 'message' && targets.marketSource === 'message';
  const requiredTool: AgentToolName = hasExplicitTargets
    ? 'create_listing_task_from_attachments'
    : 'start_listing_workflow';
  return tools.filter((item) => item.function.name === requiredTool);
}

export function soleRequiredAgentTool(
  tools: AgentToolDefinition[],
  requireTool: boolean,
): AgentToolDefinition | null {
  return requireTool && tools.length === 1 ? tools[0] : null;
}

export function buildCommerceOrchestratorPrompt(state: AgentWorkflowState): string {
  return `你是 SKUFlow 的中央上新 Agent，不是客服话术机器人。你的职责是基于可信任务状态，选择一个合适工具推进单商品、多平台 Listing 工作流。

工作原则：
0. 尚未创建商品任务时，你首先是正常的对话助手。附件只是对话上下文，绝不等于开始上新：
   - 用户询问、总结、翻译或核对本轮附件：调用 inspect_chat_attachments，然后基于工具结果回答，不创建任务。
   - 用户明确要求用本轮附件上新，并且已经明确说出至少一个平台和一个目标市场/站点：调用 create_listing_task_from_attachments。
   - 用户明确要上新，但平台或目标市场/站点任一没有说清楚：调用 start_listing_workflow 展示选择卡。即使附件已经齐全，也绝不能默认替卖家选择。
   - 普通咨询且无需读取附件：直接回答，不调用工具，不展示卡片。
1. 只要还有可执行的内部步骤，就调用工具，不要只描述“将要执行”。
2. 工具之间有依赖，必须串行：解析资料 → 图片分析（若有图片）→ 合并商品事实 → 处理冲突 → 询问是否为同一商品制作多套场景、各要几套 → 按场景生成独立的平台 Listing → 人工审核 → 询问图片要求 → 为每套场景生成匹配图片 → 商家确认图片 → 视频可选 → 人工确认交付。
3. 商品事实必须来自原始资料或图片证据。营销标题、卖点等平台字段可以由 Agent 创作，但要标记来源。
4. 发现图文冲突时只能调用 open_conflict_review，在对话中逐项询问商家，绝不能替商家选择，也不要使用弹窗打断对话。
5. Listing 必须由商家审核；素材必须由商家选择；发布必须得到本轮明确授权。不要绕过人工门禁。
6. 只有工具列表中出现的工具才允许调用。不要重复执行已经完成的步骤，除非用户明确要求重新生成。
7. 每轮最多调用一个工具。工具返回后再根据最新状态决定下一步。
8. 面向商家的自然语言使用简洁中文，说明正在为商品做什么、完成后商家会看到什么。不要提及工具调用、内部步骤、接口、模型选择或字段校验等实现细节；也不要伪造结果。
9. 不要因为检测到附件就自行假设商品、平台或任务意图；结合本会话用户的明确要求和后续补答判断；普通咨询不能触发上新。
9.1 不存在默认平台和默认站点。只有卖家在消息中明确说出，或在选择卡中主动选择，才可创建任务。
10.0 用户要裁剪、缩短、去掉已有视频片段时，必须调用 trim_product_video，不能调用图片或视频重新生成工具。你根据用户的大致时间描述和可信视频时长自行决定保留start/end；例如“去掉前半段”保留duration/2到终点，“保留后3秒”保留max(0,duration-3)到终点，“开头大约2秒不要”保留2到终点。无需让商家填写秒数或确认裁剪方案，工具内部完成加载、裁剪、保存，直接返回结果视频。不能声称已分析画面中空镜头的准确结束点；用户有大致时间时据此裁剪，完全没有时间且需画面判断时简短询问大致时段。视频编号按可信videoCandidates.ordinal。只有目标视频确实无法判断时才询问是哪条。结果可继续通过自然语言修改，发布仍遵守最终确认门禁。面向用户只说正在处理或已完成，不展示起止参数、编码步骤或裁剪操作教程。
10. 首次生成图片前必须等商家在卡片或自然语言中确认图片要求；商家可以指定 1–6 张，也可以明确交给你决定。你只需在商家要求生成或修改图片时调用 generate_visual_assets；专门的图片需求分析 Agent 会结合本轮原话与已有图片判断整组生成或局部修改，中央 Agent 不必传 scope 或图片序号。图片规划完全以商家本轮要求为准，不补入未要求的固定图种。图片工具只生成图片，绝不能启动视频。封面及媒体顺序留给后续编排；用户只改顺序时调用 revise_media_order，不调用图片生成。视频只在商家确认最终图片后通过 generate_product_video 开始；仅改视频调用 revise_product_video，保留图片。
11. 图片生成后调用 open_asset_selection 展示本次图片，不要循环生成。用户说“不要细节图”“去掉模特”“不符合实际”等图片要求时，即使已有素材，也必须调用 generate_visual_assets 落实要求；若指明具体图片就只改该图。海报属于可选图片风格，不应误判为整组重做。
12. 商家确认图片后调用 generate_product_video；视频生成后让商家预览、选择或跳过，再进入发布确认。图片阶段绝不代替商家决定视频已完成。
13. 回退与改目标：用户想“重新选站点/平台/市场”“改目标站点”“换平台再来”时，调用 open_target_selection 展示当前选择，商家可以直接修改并保存。图文冲突和已确认的事实与平台无关，改目标不会丢失这些进度；旧 Listing 审校稿会作废。已发布过草稿的任务不可改目标，需如实告知。
14. 回退到更早的步骤：用户说“重新解析资料”“文件识别错了/内容更新了”调用 reparse_sources；“重新看图”“图片属性识别错了”调用 reanalyze_images；“重新裁决冲突”“改一下之前冲突的选择”调用 reopen_resolved_conflicts。这三个工具都会作废未发布的旧审校稿，完成后按状态继续正常流程（例如重新解析后继续重新理解图片、重新合并事实，再回到冲突确认或 Listing 生成）。merge_product_facts 在未发布前始终可用，用于事实变化后的重新合并；除此之外不要重复执行已完成的步骤。这些回退工具只在用户本轮明确提出对应意图时才会出现在工具列表里；如果列表里没有，先用自然语言向商家确认具体想回退到哪一步，不要尝试调用列表外的工具。所有回退在任务发布后不可用，需如实告知。

当前可信状态：
${JSON.stringify(state, null, 2)}`;
}

const BACKTRACK_INTENT_PATTERNS: Array<{ pattern: RegExp; tool: AgentToolName }> = [
  { pattern: /重新解析|重新识别文件|解析.{0,6}(?:错|错漏|失败|不对|更新)|资料.{0,8}(?:变了|更新了|换了)/, tool: 'reparse_sources' },
  { pattern: /重新(?:看|分析|理解|识别).{0,6}(?:图|图片|实物)|图片.{0,8}(?:识别|理解).{0,4}错|重新拍|重拍/, tool: 'reanalyze_images' },
  { pattern: /重新裁决|重新确认冲突|重开冲突| reopen |改.{0,4}冲突(?:的)?(?:选择|答案|裁决)|之前.{0,6}冲突.{0,8}(?:选错|改)/, tool: 'reopen_resolved_conflicts' },
  { pattern: /重新选|改目标|换平台|换站点|重新选站点|重新选平台|改成.{0,12}(?:平台|站点|市场)|只上|再加一个平台|去掉一个平台/, tool: 'open_target_selection' },
];

export function shouldOpenTargetSelection(text: string, taskId: string | null, publishedDraftCount: number): boolean {
  return Boolean(taskId) && publishedDraftCount === 0
    && /(?:重新|再|返回|回去|修改|更改|重选|换).{0,12}(?:平台|站点|市场)|(?:平台|站点|市场).{0,12}(?:重新|重选|选错|换|修改)/.test(text);
}

export function requiredListingStageTool(state: AgentWorkflowState): AgentToolName | null {
  if (!state.taskId || state.publishedDraftCount > 0 || state.factCount === 0 || state.openConflictCount > 0 || state.draftCount === 0) return null;
  if (!state.scenePlanConfirmed && state.generatedDraftCount === 0) return 'open_scene_plan';
  if (state.generatedDraftCount < state.draftCount) return 'generate_platform_listings';
  if (state.approvedDraftCount < state.draftCount) return 'open_listing_review';
  return null;
}

// 回退能力按用户意图动态注入：平时不占工具列表（保住唯一工具恢复机制），
// 用户表达回退意图时才给出对应工具，且发布后一律不可回退。
export function withBacktrackTools(tools: AgentToolDefinition[], messages: AgentModelMessage[], state: AgentWorkflowState): AgentToolDefinition[] {
  if (!state.taskId || state.publishedDraftCount > 0) return tools;
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  if (lastUser?.role !== 'user') return tools;
  const wanted = new Set<AgentToolName>();
  for (const { pattern, tool } of BACKTRACK_INTENT_PATTERNS) {
    if (pattern.test(lastUser.content)) wanted.add(tool);
  }
  if (wanted.size === 0) return tools;
  if (state.fileCount === 0) wanted.delete('reparse_sources');
  if (state.imageCount === 0) wanted.delete('reanalyze_images');
  if (state.resolvedConflictCount === 0) wanted.delete('reopen_resolved_conflicts');
  const existing = new Set(tools.map((item) => item.function.name));
  const additions = [...wanted].filter((name) => !existing.has(name));
  if (additions.length === 0) return tools;
  return [...tools, ...additions.map(tool)];
}

export function withRegenerationTool(tools: AgentToolDefinition[], messages: AgentModelMessage[], state: AgentWorkflowState): AgentToolDefinition[] {  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
  const requested = lastUser?.role === 'user'
    && /封面|排序|顺序|视频.*放.*第|重新生成|重写|再生成|重新规划|换一批|换成|想要.*(?:素材|图片|主图|场景)|增加.*(?:素材|图片|视频)|生成.*(?:素材|图片|视频)/.test(lastUser.content);
  if (!requested || state.factCount === 0 || state.openConflictCount > 0 || state.publishedDraftCount > 0) return tools;
  const completedAfterRequest = new Set(messages.slice(lastUserIndex + 1)
    .filter((message) => message.role === 'tool')
    .map((message) => message.role === 'tool' ? message.name : null));
  const visualRequested = state.generatedAssetCount > 0 || (lastUser.role === 'user' && /封面|排序|顺序|素材|图片|视频|video|视觉|主图|场景图/.test(lastUser.content));
  if (visualRequested && state.draftCount > 0 && state.approvedDraftCount >= state.draftCount) {
    // Let the central Agent distinguish editing, video generation and media ordering.
    // Forcing this list to a single generator discards dedicated edit tools.
    return tools;
  }
  if (completedAfterRequest.has('generate_platform_listings')) return tools;
  if (tools.some((item) => item.function.name === 'generate_platform_listings')) return tools;
  return [...tools, {
    type: 'function',
    function: {
      name: 'generate_platform_listings',
      description: '按用户最新要求重新生成各平台中文 Listing 审校稿。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  }];
}
