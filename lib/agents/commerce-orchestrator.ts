import type { AgentModelMessage, AgentToolDefinition, AgentToolName, AgentWorkflowState } from '../domain/agent-orchestrator.ts';
import { inferIntakeTargets } from './intake-targets.ts';

const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  inspect_chat_attachments: '读取本轮聊天附件并返回可供回答的文档内容、表格内容或图片理解结果。仅当用户是在询问、总结或核对附件，而不是要求创建商品上新任务时调用。',
  create_listing_task_from_attachments: '把本轮聊天附件保存为新的商品上新任务。仅当用户明确要求上新，并且已经在消息中明确指定至少一个平台和一个目标市场/站点时调用；不得使用默认平台或默认站点。',
  start_listing_workflow: '仅在用户有上新意图且仍缺少必要信息时，展示只包含缺失项的对话卡。结合本会话此前的选择和附件；已有资料无需重传，目标和资料齐全时直接创建任务。',
  parse_product_sources: '解析当前任务中的图片、PDF、表格和文本资料，形成统一内容块。',
  analyze_product_images: '调用当前百炼多模态模型读取全部商品实物图，提取可见属性和视觉证据。',
  merge_product_facts: '调用商品事实 Agent 合并文档与图片证据，生成统一商品属性并识别图文冲突。',
  generate_platform_listings: '读取所选平台字段（Shopify 使用真实接口），并由 Listing Agent 生成各平台中文审校稿。',
  open_conflict_review: '暂停自动执行，并在对话流中逐项询问商家如何处理图文冲突；不得打开遮罩弹窗。',
  open_listing_review: '暂停自动执行并向商家展示各平台中文 Listing 审核界面。',
  generate_visual_assets: '根据商品、平台和本轮要求统一规划并生成图片与视频候选。已有素材时仍可调用此工具落实修改、排除或新增要求；不要用展示旧素材代替重新生成。视频按实际任务状态报告。',
  revise_product_video: '依据上一条视频方案和商家本轮要求重新规划并生成一条商品视频；仅修改视频时使用，保留已有图片。视频镜头、背景、时长、动作修改使用此工具，商品媒体排序使用媒体编排。',
  trim_product_video: '裁剪已有视频，打开目标视频与保留时段确认卡，不调用生成模型、不重做图片。只移除片段、缩短、去掉开头结尾时使用。videoId 使用可信视频ID；时间单位秒，未明确的时间或目标可以留空让卖家预览确认。',
  open_asset_selection: '向商家展示已经真实生成并保存的视觉素材候选，让商家选择交付素材。',
  open_publish_confirmation: '展示最终发布确认卡；调用此工具不会发布。',
  publish_mock_drafts: '在商家明确确认后创建平台测试草稿：Shopify 使用官方 Dev Store API 创建未公开 DRAFT，其他平台暂时使用本地 Mock。',
};

function tool(name: AgentToolName): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: TOOL_DESCRIPTIONS[name],
      parameters: { type: 'object', properties: name === 'trim_product_video' ? {videoId:{type:'string',description:'要裁剪的可信视频ID；不确定则省略'},start:{type:'number',description:'保留起点秒数；不确定则省略'},end:{type:'number',description:'保留终点秒数；不确定则省略'}} : {}, additionalProperties: false },
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

  if (!parsingReady) names.push('parse_product_sources');
  if (parsingReady && !visionReady) names.push('analyze_product_images');
  if (parsingReady && visionReady && state.factCount === 0) names.push('merge_product_facts');
  if (state.openConflictCount > 0) names.push('open_conflict_review');
  if (state.factCount > 0 && state.openConflictCount === 0 && state.generatedDraftCount === 0 && state.publishedDraftCount === 0) {
    names.push('generate_platform_listings');
  }
  if (state.generatedDraftCount > 0 && !allDraftsApproved) names.push('open_listing_review');
  if (allDraftsApproved && state.publishedDraftCount === 0 && !state.publishApproved) names.push('generate_visual_assets');
  if (allDraftsApproved && state.generatedAssetCount > 0 && state.publishedDraftCount === 0 && !state.publishApproved) names.push('revise_product_video');
  if (allDraftsApproved && state.publishedDraftCount === 0 && state.generatedAssetCount > 0 && state.selectedAssetCount === 0) names.push('open_asset_selection');
  if (allDraftsApproved && state.publishedDraftCount === 0 && state.generatedAssetCount > 0 && state.selectedAssetCount > 0 && !state.publishApproved) {
    names.push('open_publish_confirmation');
  }
  if (allDraftsApproved && state.publishedDraftCount === 0 && state.generatedAssetCount > 0 && state.selectedAssetCount > 0 && state.publishApproved) {
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
2. 工具之间有依赖，必须串行：解析资料 → 图片分析（若有图片）→ 合并商品事实 → 处理冲突 → 生成平台 Listing → 人工审核 → 视觉策划 Agent 动态规划并生成素材 → 人工选图 → 人工确认发布 → 创建平台测试草稿。
3. 商品事实必须来自原始资料或图片证据。营销标题、卖点等平台字段可以由 Agent 创作，但要标记来源。
4. 发现图文冲突时只能调用 open_conflict_review，在对话中逐项询问商家，绝不能替商家选择，也不要使用弹窗打断对话。
5. Listing 必须由商家审核；素材必须由商家选择；发布必须得到本轮明确授权。不要绕过人工门禁。
6. 只有工具列表中出现的工具才允许调用。不要重复执行已经完成的步骤，除非用户明确要求重新生成。
7. 每轮最多调用一个工具。工具返回后再根据最新状态决定下一步。
8. 面向商家的自然语言使用简洁中文。调用工具时可以附一句简短说明，但不要伪造工具结果。
9. 不要因为检测到附件就自行假设商品、平台或任务意图；结合本会话用户的明确要求和后续补答判断；普通咨询不能触发上新。
9.1 不存在默认平台和默认站点。只有卖家在消息中明确说出，或在选择卡中主动选择，才可创建任务。
10.0 用户要裁剪、缩短、去掉已有视频片段时，必须调用 trim_product_video，不能调用图片或视频重新生成工具。只根据用户明确时间确定保留区间；“前半段”可按视频时长取一半，但“空镜头结束”没有准确秒数时不要猜，打开卡片让卖家预览确认。视频编号按可信 videoCandidates.ordinal，与页面从上往下顺序一致。若目标不明确不要擅自选，留空让卖家选择。裁剪后仍需卖家预览确认采用裁剪版。
10. 已有素材时用户只修改或新增视频，必须调用 revise_product_video；它依据上一条视频方案落实镜头、场景、动作、时长要求并启动新视频，不重做图片。视频内部镜头顺序不是商品媒体排序。首次图片与视频一起规划使用 generate_visual_assets。只调整商品封面、图片/视频在商品媒体中的位置时调用 generate_visual_assets 打开媒体编排。
11. 生成工具完成且用户没有新的修改要求时，应调用 open_asset_selection 展示本次结果，不要循环生成。用户说“不要细节图”“去掉模特”“不符合实际”等要求时，即使已有素材，也必须调用 generate_visual_assets 落实要求，再展示新结果。
12. 视觉素材不能套用固定三场景。用户在素材阶段提出“换成户外场景”“重新生成主图”等要求时，应调用 generate_visual_assets 重新规划，不要只展示旧素材。

当前可信状态：
${JSON.stringify(state, null, 2)}`;
}

export function withRegenerationTool(tools: AgentToolDefinition[], messages: AgentModelMessage[], state: AgentWorkflowState): AgentToolDefinition[] {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
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

