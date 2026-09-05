import type { AgentToolDefinition, AgentToolName, AgentWorkflowState } from '../domain/agent-orchestrator.ts';

const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  inspect_chat_attachments: '读取本轮聊天附件并返回可供回答的文档内容、表格内容或图片理解结果。仅当用户是在询问、总结或核对附件，而不是要求创建商品上新任务时调用。',
  create_listing_task_from_attachments: '把本轮聊天附件保存为一个新的商品上新任务，并根据用户消息识别目标平台和市场。仅当用户明确要求上新、发布商品或制作 Listing 时调用。',
  start_listing_workflow: '展示平台、市场与资料填写卡片。仅当用户明确要上新，但尚未提供可直接建任务的附件，或明确希望通过表单补充目标与资料时调用。',
  parse_product_sources: '解析当前任务中的图片、PDF、表格和文本资料，形成统一内容块。',
  analyze_product_images: '调用当前百炼多模态模型读取全部商品实物图，提取可见属性和视觉证据。',
  merge_product_facts: '调用商品事实 Agent 合并文档与图片证据，生成统一商品属性并识别图文冲突。',
  generate_platform_listings: '读取所选平台的 Mock Listing 字段，并由 Listing Agent 生成各平台中文审校稿。',
  open_conflict_review: '暂停自动执行并向商家展示图文冲突确认卡。',
  open_listing_review: '暂停自动执行并向商家展示各平台中文 Listing 审核界面。',
  open_asset_selection: '向商家展示视觉素材候选，让商家选择交付素材。',
  open_publish_confirmation: '展示最终发布确认卡；调用此工具不会发布。',
  publish_mock_drafts: '在商家明确确认后，把已审核的 Listing 创建为 Mock 平台草稿。',
};

function tool(name: AgentToolName): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: TOOL_DESCRIPTIONS[name],
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  };
}

export function availableAgentTools(state: AgentWorkflowState): AgentToolDefinition[] {
  if (!state.taskId) {
    const names: AgentToolName[] = [];
    if (state.pendingAttachmentCount > 0) names.push('inspect_chat_attachments', 'create_listing_task_from_attachments');
    if (!state.intakePresented) names.push('start_listing_workflow');
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
  if (allDraftsApproved && state.publishedDraftCount === 0 && state.selectedAssetCount === 0) names.push('open_asset_selection');
  if (allDraftsApproved && state.publishedDraftCount === 0 && state.selectedAssetCount > 0 && !state.publishApproved) {
    names.push('open_publish_confirmation');
  }
  if (allDraftsApproved && state.publishedDraftCount === 0 && state.selectedAssetCount > 0 && state.publishApproved) {
    names.push('publish_mock_drafts');
  }
  return [...new Set(names)].map(tool);
}

export function buildCommerceOrchestratorPrompt(state: AgentWorkflowState): string {
  return `你是 SKUFlow 的中央上新 Agent，不是客服话术机器人。你的职责是基于可信任务状态，选择一个合适工具推进单商品、多平台 Listing 工作流。

工作原则：
0. 尚未创建商品任务时，你首先是正常的对话助手。附件只是对话上下文，绝不等于开始上新：
   - 用户询问、总结、翻译或核对本轮附件：调用 inspect_chat_attachments，然后基于工具结果回答，不创建任务。
   - 用户明确要求用本轮附件上新、发布商品或制作 Listing：调用 create_listing_task_from_attachments。
   - 用户明确要上新但没有附件，或明确希望补填平台、市场和资料：调用 start_listing_workflow 展示填写卡片。
   - 普通咨询且无需读取附件：直接回答，不调用工具，不展示卡片。
1. 只要还有可执行的内部步骤，就调用工具，不要只描述“将要执行”。
2. 工具之间有依赖，必须串行：解析资料 → 图片分析（若有图片）→ 合并商品事实 → 处理冲突 → 生成平台 Listing → 人工审核 → 选择素材 → 人工确认发布 → 创建 Mock 草稿。
3. 商品事实必须来自原始资料或图片证据。营销标题、卖点等平台字段可以由 Agent 创作，但要标记来源。
4. 发现图文冲突时只能调用 open_conflict_review，绝不能替商家选择。
5. Listing 必须由商家审核；素材必须由商家选择；发布必须得到本轮明确授权。不要绕过人工门禁。
6. 只有工具列表中出现的工具才允许调用。不要重复执行已经完成的步骤，除非用户明确要求重新生成。
7. 每轮最多调用一个工具。工具返回后再根据最新状态决定下一步。
8. 面向商家的自然语言使用简洁中文。调用工具时可以附一句简短说明，但不要伪造工具结果。
9. 不要因为检测到附件就自行假设商品、平台或任务意图；必须以用户本轮自然语言为准。

当前可信状态：
${JSON.stringify(state, null, 2)}`;
}
