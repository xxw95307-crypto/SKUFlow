'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ListingWorkspace } from '@/components/listing-workspace';
import { TaskIntake } from '@/components/task-intake';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import type {
  AgentModelMessage,
  AgentOrchestratorResponse,
  AgentToolCall,
  AgentToolName,
  AgentWorkflowState,
} from '@/lib/domain/agent-orchestrator';
import type { AgentConversationRecord, ConversationSummary } from '@/lib/domain/conversation';
import type { FactConflict, FactValue, ProductPassport } from '@/lib/domain/product-passport';
import { PENDING_PRODUCT_NAME, type TaskSnapshot } from '@/lib/domain/task';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { platformRegistry } from '@/lib/platforms/registry';

type AgentPhase = 'loading' | 'idle' | 'intake' | 'resume' | 'processing' | 'conflict' | 'listing' | 'assets' | 'publish' | 'complete' | 'error';

interface ChatMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
  meta?: string;
}

interface ToolRun {
  id: string;
  name: AgentToolName;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
}

const toolLabels: Record<AgentToolName, string> = {
  start_listing_workflow: '启动商品上新',
  parse_product_sources: '解析原始资料',
  analyze_product_images: '理解商品图片',
  merge_product_facts: '合并商品事实',
  generate_platform_listings: '生成平台 Listing',
  open_conflict_review: '请求冲突确认',
  open_listing_review: '请求 Listing 审核',
  open_asset_selection: '请求素材选择',
  open_publish_confirmation: '请求发布确认',
  publish_mock_drafts: '创建 Mock 平台草稿',
};

const assetCandidates = [
  { id: 'main-square', type: '主图 · 1:1', title: '平台白底主图', note: '适用于商品列表和搜索入口' },
  { id: 'lifestyle', type: '场景图 · 4:5', title: '生活方式场景', note: '用于表达使用情境和商品氛围' },
  { id: 'infographic', type: '信息图 · 1:1', title: '核心卖点信息图', note: '只展示已确认的商品事实' },
  { id: 'detail', type: '细节图 · 3:4', title: '结构与材质细节', note: '放大展示外观、工艺或部件' },
];

const initialMessages: ChatMessage[] = [{
  id: 'welcome',
  role: 'agent',
  text: '你好，我是 SKUFlow Agent。你可以直接告诉我今天想做什么，例如“我要上新一款商品”，也可以先问我有关平台 Listing 的问题。',
  meta: '等待你的消息',
}];

function messageId(): string {
  return `message_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function displayValue(value: FactValue, unit?: string | null): string {
  const rendered = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);
  return unit ? `${rendered} ${unit}` : rendered;
}

function sourceLabel(sourceKind?: string): string {
  if (sourceKind === 'VISION') return '图片识别';
  if (sourceKind === 'FILE_TEXT' || sourceKind === 'OCR') return '文档资料';
  if (sourceKind === 'USER_INPUT') return '商家确认';
  return '资料来源';
}

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || fallback);
  return payload;
}

function AgentDialog({ eyebrow, title, children, onClose, wide = false }: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return <div className="agent-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`agent-dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><div><span>{eyebrow}</span><h2>{title}</h2></div><button type="button" onClick={onClose} aria-label="关闭弹窗">×</button></header>
      <div className="agent-dialog-body">{children}</div>
    </section>
  </div>;
}

function ConflictDialog({ passport, busy, manualValue, onManualValue, onResolve, onClose }: {
  passport: ProductPassport;
  busy: boolean;
  manualValue: string;
  onManualValue: (value: string) => void;
  onResolve: (conflict: FactConflict, candidateId?: string) => void;
  onClose: () => void;
}) {
  const conflicts = passport.conflicts.filter((item) => item.status === 'OPEN');
  const conflict = conflicts[0];
  if (!conflict) return null;
  const label = passport.facts.find((fact) => fact.key === conflict.factKey)?.label ?? conflict.factKey;
  return <AgentDialog eyebrow={`需要你决定 · ${conflicts.length} 项待处理`} title={`请确认：${label}`} onClose={onClose}>
    <div className="decision-intro"><span>!</span><p>图片和文档对这个属性给出了不同答案。Agent 不会擅自覆盖，请选择正确值。</p></div>
    <div className="decision-options">{conflict.candidates.map((candidate) => <button type="button" disabled={busy} key={candidate.id} onClick={() => onResolve(conflict, candidate.id)}>
      <small>{sourceLabel(candidate.sourceKind)}</small>
      <b>{displayValue(candidate.value, candidate.unit)}</b>
      <span>{candidate.sourceLabel}</span>
      <strong>采用这个值 →</strong>
    </button>)}</div>
    <div className="decision-manual"><label htmlFor="manual-conflict">我已经人工核实</label><div><input id="manual-conflict" value={manualValue} onChange={(event) => onManualValue(event.target.value)} placeholder="输入正确值" maxLength={240} /><button type="button" disabled={busy || !manualValue.trim()} onClick={() => onResolve(conflict)}>{busy ? '写入中…' : '采用人工值'}</button></div></div>
  </AgentDialog>;
}

function AssetDialog({ selected, onToggle, onConfirm, onClose }: {
  selected: string[];
  onToggle: (id: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return <AgentDialog eyebrow="AGENT CHECKPOINT · VISUAL ASSETS" title="视觉候选已准备好" onClose={onClose} wide>
    <p className="dialog-lead">选择要随 Listing 一起交付的视觉方案。当前是用于跑通流程的 Mock 候选，不伪装成真实模型产物。</p>
    <div className="agent-asset-grid">{assetCandidates.map((asset, index) => <button type="button" className={selected.includes(asset.id) ? 'selected' : ''} onClick={() => onToggle(asset.id)} key={asset.id}>
      <span className={`agent-asset-preview tone-${index + 1}`}><i>{selected.includes(asset.id) ? '✓' : '+'}</i><b>{asset.type}</b></span>
      <strong>{asset.title}</strong><small>{asset.note}</small>
    </button>)}</div>
    <div className="dialog-footer"><span>已选择 {selected.length} 个方案</span><button className="primary" type="button" disabled={selected.length === 0} onClick={onConfirm}>确认素材并继续</button></div>
  </AgentDialog>;
}

function PublishDialog({ task, passport, selectedAssets, busy, onPublish, onClose }: {
  task: TaskSnapshot;
  passport: ProductPassport;
  selectedAssets: string[];
  busy: boolean;
  onPublish: () => void;
  onClose: () => void;
}) {
  const approved = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED');
  return <AgentDialog eyebrow="FINAL CHECKPOINT · DELIVERY" title="确认发布这个商品？" onClose={onClose}>
    <div className="publish-confirm-product"><span>↗</span><div><b>{task.productName}</b><small>{approved.length} 个平台 Listing · {selectedAssets.length} 个视觉方案</small></div></div>
    <dl className="publish-confirm-list"><div><dt>目标平台</dt><dd>{approved.map((draft) => platformRegistry.find((item) => item.id === draft.platformId)?.shortName ?? draft.platformId).join('、')}</dd></div><div><dt>目标市场</dt><dd>{[...new Set(approved.map((draft) => draft.market))].join('、')}</dd></div><div><dt>审核版本</dt><dd>简体中文审校稿</dd></div><div><dt>发布模式</dt><dd>Mock 平台草稿</dd></div></dl>
    <div className="publish-warning"><b>当前 Demo 边界</b><span>本地化和真实平台 API 尚未连接；本次只会创建 Mock 草稿，不会修改真实店铺。</span></div>
    <div className="dialog-footer"><button className="ghost" type="button" onClick={onClose}>再检查一下</button><button className="primary" type="button" disabled={busy || approved.length === 0} onClick={onPublish}>{busy ? '发布中…' : `确认并创建 ${approved.length} 个草稿`}</button></div>
  </AgentDialog>;
}

function listingTitle(payload: ListingDraftPayload): string {
  const preferred = ['item_name', 'title', 'product_name'];
  for (const key of preferred) {
    const value = payload.fields[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '中文 Listing 已生成';
}

export function AgentConversation() {
  const [phase, setPhase] = useState<AgentPhase>('loading');
  const [progressStep, setProgressStep] = useState(0);
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [passport, setPassport] = useState<ProductPassport | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [busyLabel, setBusyLabel] = useState('正在读取最近任务…');
  const [error, setError] = useState('');
  const [composer, setComposer] = useState('');
  const [conflictOpen, setConflictOpen] = useState(false);
  const [listingOpen, setListingOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [manualConflictValue, setManualConflictValue] = useState('');
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [toolRuns, setToolRuns] = useState<ToolRun[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  const modelHistory = useRef<AgentModelMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>(initialMessages);
  const toolRunsRef = useRef<ToolRun[]>([]);
  const selectedAssetsRef = useRef<string[]>([]);
  const conversationIdRef = useRef<string | null>(null);

  const platformNames = useMemo(() => new Map(platformRegistry.map((item) => [item.id, item.shortName])), []);
  const currentStep = phase === 'conflict' ? 1 : phase === 'listing' ? 2 : phase === 'assets' ? 3 : phase === 'publish' || phase === 'complete' ? 4 : phase === 'processing' ? progressStep : 0;

  const append = (role: ChatMessage['role'], text: string, meta?: string) => {
    const next = [...messagesRef.current, { id: messageId(), role, text, meta }].slice(-200);
    messagesRef.current = next;
    setMessages(next);
  };

  const fetchPassport = async (taskId: string): Promise<ProductPassport> => {
    const payload = await responseJson<{ passport: ProductPassport }>(await fetch(`/api/tasks/${taskId}/passport`), '商品档案读取失败');
    return payload.passport;
  };

  const fetchTask = async (taskId: string): Promise<TaskSnapshot> => {
    const payload = await responseJson<{ task: TaskSnapshot }>(await fetch(`/api/tasks/${taskId}`), '任务状态读取失败');
    return payload.task;
  };

  const updateConversationList = (conversation: AgentConversationRecord | ConversationSummary) => {
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
  };

  const applyConversation = async (conversation: AgentConversationRecord) => {
    conversationIdRef.current = conversation.id;
    setConversationId(conversation.id);
    messagesRef.current = conversation.messages.length ? conversation.messages : initialMessages;
    setMessages(messagesRef.current);
    modelHistory.current = conversation.modelHistory;
    toolRunsRef.current = conversation.toolRuns;
    setToolRuns(conversation.toolRuns);
    selectedAssetsRef.current = conversation.selectedAssetIds;
    setSelectedAssets(conversation.selectedAssetIds);
    setError(''); setComposer('');
    setConflictOpen(false); setListingOpen(false); setAssetOpen(false); setPublishOpen(false);
    updateConversationList(conversation);
    if (!conversation.taskId) {
      const intakeStarted = conversation.toolRuns.some((run) => run.name === 'start_listing_workflow' && run.status === 'COMPLETED');
      setTask(null); setPassport(null); setPhase(intakeStarted ? 'intake' : 'idle'); setProgressStep(0);
      return;
    }
    const [loadedTask, loadedPassport] = await Promise.all([fetchTask(conversation.taskId), fetchPassport(conversation.taskId)]);
    setTask(loadedTask); setPassport(loadedPassport);
    const openConflicts = loadedPassport.conflicts.some((item) => item.status === 'OPEN');
    const published = loadedPassport.platformDrafts.some((draft) => draft.status === 'DRAFT_CREATED');
    const generated = loadedPassport.platformDrafts.some((draft) => isListingDraftPayload(draft.payload));
    const allApproved = loadedPassport.platformDrafts.length > 0 && loadedPassport.platformDrafts.every((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
    setPhase(published ? 'complete' : openConflicts ? 'conflict' : allApproved ? (conversation.selectedAssetIds.length ? 'publish' : 'assets') : generated ? 'listing' : 'resume');
  };

  const persistConversation = async (taskIdOverride?: string | null, statusOverride?: 'ACTIVE' | 'COMPLETED') => {
    const id = conversationIdRef.current;
    if (!id) return;
    const payload = await responseJson<{ conversation: AgentConversationRecord }>(await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: taskIdOverride === undefined ? task?.id ?? null : taskIdOverride,
        status: statusOverride ?? (phase === 'complete' ? 'COMPLETED' : 'ACTIVE'),
        messages: messagesRef.current,
        modelHistory: modelHistory.current.slice(-48),
        toolRuns: toolRunsRef.current,
        selectedAssetIds: selectedAssetsRef.current,
      }),
    }), '会话保存失败');
    updateConversationList(payload.conversation);
  };

  const loadConversation = async (id: string) => {
    if (id === conversationIdRef.current) return;
    await persistConversation();
    setPhase('loading'); setBusyLabel('正在恢复会话记忆…');
    const payload = await responseJson<{ conversation: AgentConversationRecord }>(await fetch(`/api/conversations/${id}`), '会话读取失败');
    await applyConversation(payload.conversation);
  };

  const createConversation = async (taskId?: string) => {
    const payload = await responseJson<{ conversation: AgentConversationRecord }>(await fetch('/api/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(taskId ? { taskId } : {}),
    }), '新建会话失败');
    await applyConversation(payload.conversation);
    return payload.conversation;
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const listed = await responseJson<{ conversations: ConversationSummary[] }>(await fetch('/api/conversations'), '会话列表读取失败');
        if (!active) return;
        setConversations(listed.conversations);
        if (listed.conversations[0]) {
          const payload = await responseJson<{ conversation: AgentConversationRecord }>(await fetch(`/api/conversations/${listed.conversations[0].id}`), '会话读取失败');
          if (active) await applyConversation(payload.conversation);
          return;
        }
        const tasksPayload = await responseJson<{ tasks: TaskSnapshot[] }>(await fetch('/api/tasks'), '任务读取失败');
        if (!active) return;
        await createConversation(tasksPayload.tasks[0]?.id);
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : '会话读取失败');
        setPhase('idle');
      }
    })();
    return () => { active = false; };
  // Initial hydration deliberately runs once; switching is handled by loadConversation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { threadEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, phase, busyLabel]);

  const refreshTaskState = async (taskId: string) => {
    const [nextTask, nextPassport] = await Promise.all([fetchTask(taskId), fetchPassport(taskId)]);
    setTask(nextTask);
    setPassport(nextPassport);
    return { task: nextTask, passport: nextPassport };
  };

  const phaseFromState = (state: AgentWorkflowState) => {
    if (!state.taskId) return setPhase(state.intakePresented ? 'intake' : 'idle');
    if (state.publishedDraftCount > 0) return setPhase('complete');
    if (state.openConflictCount > 0) return setPhase('conflict');
    if (state.generatedDraftCount > 0 && state.approvedDraftCount < state.draftCount) return setPhase('listing');
    if (state.draftCount > 0 && state.approvedDraftCount >= state.draftCount) {
      return setPhase(state.selectedAssetCount > 0 ? 'publish' : 'assets');
    }
    setPhase('resume');
  };

  const markToolRun = (call: AgentToolCall, status: ToolRun['status']) => {
    const existing = toolRunsRef.current.find((item) => item.id === call.id);
    const next = existing
      ? toolRunsRef.current.map((item) => item.id === call.id ? { ...item, status } : item)
      : [...toolRunsRef.current, { id: call.id, name: call.function.name, status }].slice(-12);
    toolRunsRef.current = next;
    setToolRuns(next);
  };

  const executeTool = async (
    call: AgentToolCall,
    currentTask: TaskSnapshot | null,
    publishApproved: boolean,
  ): Promise<{ result: Record<string, unknown>; checkpoint: boolean; completed?: boolean }> => {
    const name = call.function.name;
    markToolRun(call, 'RUNNING');
    try {
      if (name === 'start_listing_workflow') {
        setPhase('intake');
        append('agent', '好的，我们开始创建商品上新任务。请先选择目标市场和平台，再上传同一个商品的全部资料。', '等待平台与资料');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true }, checkpoint: true };
      }
      if (!currentTask) throw new Error('当前还没有创建商品任务');
      if (name === 'parse_product_sources') {
        setProgressStep(0); setBusyLabel('Agent 正在解析图片、表格和文档…');
        const payload = await responseJson<{ summary: Record<string, unknown> }>(await fetch(`/api/tasks/${currentTask.id}/parse`, { method: 'POST' }), '资料解析失败');
        await refreshTaskState(currentTask.id);
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary }, checkpoint: false };
      }
      if (name === 'analyze_product_images') {
        setProgressStep(1); setBusyLabel('Agent 正在调用百炼理解商品实物图…');
        const payload = await responseJson<{ summary: { completed: number; failed: number } }>(await fetch(`/api/tasks/${currentTask.id}/analyze-images`, { method: 'POST' }), '图片理解失败');
        if (payload.summary.completed === 0) throw new Error(`图片理解未得到有效结果（失败 ${payload.summary.failed} 张）`);
        await refreshTaskState(currentTask.id);
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary }, checkpoint: false };
      }
      if (name === 'merge_product_facts') {
        setProgressStep(1); setBusyLabel('Agent 正在合并图文证据并检查冲突…');
        const payload = await responseJson<{ summary: Record<string, unknown>; passport: ProductPassport; task: TaskSnapshot }>(await fetch(`/api/tasks/${currentTask.id}/extract-facts`, { method: 'POST' }), '商品事实合并失败');
        setPassport(payload.passport); setTask(payload.task);
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary }, checkpoint: false };
      }
      if (name === 'generate_platform_listings') {
        setProgressStep(2); setBusyLabel('Agent 正在读取平台字段并创作中文 Listing…');
        const payload = await responseJson<{ summary: Record<string, unknown>; passport: ProductPassport }>(await fetch(`/api/tasks/${currentTask.id}/compile-drafts`, { method: 'POST' }), '多平台 Listing 生成失败');
        setPassport(payload.passport);
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary }, checkpoint: false };
      }
      if (name === 'open_conflict_review') {
        const refreshed = await refreshTaskState(currentTask.id);
        const count = refreshed.passport.conflicts.filter((item) => item.status === 'OPEN').length;
        if (count === 0) throw new Error('当前没有待确认的商品属性冲突');
        setPhase('conflict'); setConflictOpen(true);
        append('agent', `我发现 ${count} 处图文冲突，已经暂停自动执行。请确认真实信息后我再继续。`, '等待人工决策');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true, openConflicts: count }, checkpoint: true };
      }
      if (name === 'open_listing_review') {
        const refreshed = await refreshTaskState(currentTask.id);
        setPhase('listing'); setListingOpen(true);
        append('agent', `我已经生成 ${refreshed.passport.platformDrafts.length} 份平台中文审校稿。请集中审核，确认后我会继续。`, '等待 Listing 审核');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true, drafts: refreshed.passport.platformDrafts.length }, checkpoint: true };
      }
      if (name === 'open_asset_selection') {
        setPhase('assets'); setAssetOpen(true);
        append('agent', '平台 Listing 已全部确认。请选择要进入交付包的视觉方案。', '等待素材选择');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true }, checkpoint: true };
      }
      if (name === 'open_publish_confirmation') {
        setPhase('publish'); setPublishOpen(true);
        append('agent', '上架包已经准备完成。请做最后一次检查，只有你明确确认后我才会调用发布工具。', '等待最终确认');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true }, checkpoint: true };
      }
      if (name === 'publish_mock_drafts') {
        if (!publishApproved) throw new Error('发布工具缺少本轮商家明确授权');
        setProgressStep(4); setBusyLabel('Agent 正在创建 Mock 平台草稿…');
        const payload = await responseJson<{ passport: ProductPassport; message?: string; results: unknown[] }>(await fetch(`/api/tasks/${currentTask.id}/publish-mock`, { method: 'POST' }), 'Mock 草稿创建失败');
        setPassport(payload.passport); setPublishOpen(false); setPhase('complete');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, message: payload.message, publishedDrafts: payload.results.length }, checkpoint: false, completed: true };
      }
      throw new Error(`不支持的 Agent 工具：${name}`);
    } catch (caught) {
      markToolRun(call, 'FAILED');
      throw caught;
    }
  };

  const runAgentTurn = async (
    currentTask: TaskSnapshot | null,
    userText: string,
    options: { appendUser?: boolean; publishApproved?: boolean; resetHistory?: boolean } = {},
  ) => {
    if (options.resetHistory) modelHistory.current = [];
    if (options.appendUser !== false) append('user', userText);
    const retainedHistory = modelHistory.current.length > 36
      ? modelHistory.current.filter((message) => message.role === 'user' || (message.role === 'assistant' && !message.toolCalls?.length)).slice(-20)
      : modelHistory.current;
    let history: AgentModelMessage[] = [...retainedHistory, { role: 'user', content: userText }];
    setPhase('processing'); setBusyLabel('中央 Agent 正在判断下一步…'); setError('');
    try {
      for (let step = 0; step < 10; step += 1) {
        const payload = await responseJson<AgentOrchestratorResponse>(await fetch('/api/agent/orchestrate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            taskId: currentTask?.id,
            messages: history,
            selectedAssetIds: selectedAssets,
            publishApproved: options.publishApproved === true,
            intakePresented: phase === 'intake' || toolRunsRef.current.some((run) => run.name === 'start_listing_workflow' && run.status === 'COMPLETED'),
            requireAction: currentTask !== null,
          }),
        }), 'Agent 无法决定下一步');
        history = [...history, {
          role: 'assistant',
          content: payload.message.content,
          ...(payload.message.toolCalls.length ? { toolCalls: payload.message.toolCalls } : {}),
        }];
        if (payload.message.content) append('agent', payload.message.content, payload.message.toolCalls.length ? '正在调用工具' : undefined);
        const call = payload.message.toolCalls[0];
        if (!call) {
          modelHistory.current = history;
          phaseFromState(payload.state);
          await persistConversation(currentTask?.id ?? null, payload.state.publishedDraftCount > 0 ? 'COMPLETED' : 'ACTIVE');
          return;
        }
        const execution = await executeTool(call, currentTask, options.publishApproved === true);
        history = [...history, {
          role: 'tool',
          toolCallId: call.id,
          name: call.function.name,
          content: JSON.stringify(execution.result),
        }];
        modelHistory.current = history;
        await persistConversation(currentTask?.id ?? null, execution.completed ? 'COMPLETED' : 'ACTIVE');
        if (execution.checkpoint) return;
      }
      throw new Error('Agent 连续执行步骤过多，已安全暂停');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Agent 执行失败';
      setError(message); setPhase('error');
      append('agent', `我在执行工具时遇到了问题：${message}`, '任务已安全暂停');
      await persistConversation(currentTask?.id ?? null).catch(() => undefined);
    }
  };

  const handleIntakeComplete = async (createdTask: TaskSnapshot) => {
    setTask(createdTask);
    setPassport(await fetchPassport(createdTask.id));
    toolRunsRef.current = []; setToolRuns([]);
    await persistConversation(createdTask.id);
    await runAgentTurn(
      createdTask,
      `已提交 ${createdTask.files.length} 份同一商品资料，目标平台：${createdTask.platforms.map((id) => platformNames.get(id) ?? id).join('、')}。请自主完成内部步骤，只在需要我决定时暂停。`,
      { resetHistory: true },
    );
  };

  const resumeTask = async () => {
    if (!task) return;
    await runAgentTurn(task, `继续处理当前商品任务：${task.productName}。请根据真实任务状态自主选择下一步工具。`);
  };

  const resolveConflict = async (conflict: FactConflict, candidateId?: string) => {
    if (!task) return;
    const candidate = candidateId ? conflict.candidates.find((item) => item.id === candidateId) : undefined;
    const chosen = candidate ? displayValue(candidate.value, candidate.unit) : manualConflictValue.trim();
    if (!chosen) return;
    setActionBusy(true); setError('');
    try {
      const payload = await responseJson<{ passport: ProductPassport }>(await fetch(`/api/tasks/${task.id}/passport`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conflictResolution: candidateId ? { conflictId: conflict.id, candidateId } : { conflictId: conflict.id, manualValue: chosen } }),
      }), '冲突确认失败');
      setPassport(payload.passport); setManualConflictValue('');
      append('user', `已确认“${passport?.facts.find((fact) => fact.key === conflict.factKey)?.label ?? conflict.factKey}”为：${chosen}`);
      const remaining = payload.passport.conflicts.filter((item) => item.status === 'OPEN');
      if (remaining.length === 0) {
        setConflictOpen(false);
        await runAgentTurn(task, '商品属性冲突已经全部由我确认，请继续自动处理。', { appendUser: false });
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : '冲突确认失败'); }
    finally { setActionBusy(false); }
  };

  const refreshAfterListing = async () => {
    if (!task) return;
    try {
      const currentPassport = await fetchPassport(task.id);
      setPassport(currentPassport);
      const allApproved = currentPassport.platformDrafts.length > 0 && currentPassport.platformDrafts.every((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
      setPhase(allApproved ? 'assets' : 'listing');
    } catch { /* Listing editor already reports its own errors. */ }
  };

  const proceedToAssets = async () => {
    setListingOpen(false);
    await refreshAfterListing();
    if (task) await runAgentTurn(task, '我已确认所有平台 Listing，请继续。', { appendUser: false });
  };

  const confirmAssets = async () => {
    setAssetOpen(false);
    if (task) await runAgentTurn(task, `我已选择 ${selectedAssets.length} 个视觉方案，请继续。`);
  };

  const publish = async () => {
    if (!task) return;
    setActionBusy(true); setError('');
    try {
      await runAgentTurn(task, '我已检查并明确确认发布，请调用发布工具。', { publishApproved: true });
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Mock 草稿创建失败'); }
    finally { setActionBusy(false); }
  };

  const newConversation = async () => {
    try {
      await persistConversation();
      await createConversation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '新建会话失败');
    }
  };

  const sendMessage = async () => {
    const text = composer.trim();
    if (!text) return;
    setComposer('');
    await runAgentTurn(task, text);
  };

  const toggleAsset = (id: string) => {
    const next = selectedAssetsRef.current.includes(id)
      ? selectedAssetsRef.current.filter((item) => item !== id)
      : [...selectedAssetsRef.current, id];
    selectedAssetsRef.current = next;
    setSelectedAssets(next);
  };

  const visibleFacts = passport?.facts.filter((fact) => fact.status !== 'MISSING') ?? [];
  const openConflictCount = passport?.conflicts.filter((conflict) => conflict.status === 'OPEN').length ?? 0;
  const approvedCount = passport?.platformDrafts.filter((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED').length ?? 0;
  const publishedCount = passport?.platformDrafts.filter((draft) => draft.status === 'DRAFT_CREATED').length ?? 0;

  return <main className="agent-shell">
    <aside className="agent-rail">
      <div className="agent-brand"><span>S</span><div><b>SKUFlow</b><small>Agentic Commerce</small></div></div>
      <button className="new-agent-task" type="button" disabled={phase === 'processing'} onClick={() => void newConversation()}><span>+</span>新建上新对话</button>
      <div className="agent-rail-label">上新会话</div>
      <div className="conversation-list">{conversations.map((item) => <button className={`conversation-item ${item.id === conversationId ? 'active' : ''}`} type="button" disabled={phase === 'processing'} onClick={() => void loadConversation(item.id)} key={item.id}><span>{item.id === conversationId ? '◉' : '○'}</span><div><b>{item.title}</b><small>{item.status === 'COMPLETED' ? '已完成' : item.taskId ? '进行中' : '等待资料'}</small></div></button>)}</div>
      <div className="agent-rail-note"><i /> <b>Agent 自动推进</b><p>只在事实冲突、主观选择和最终发布时向你提问。</p></div>
      <div className="agent-user"><span>林</span><div><b>林晓雨</b><small>品牌运营</small></div></div>
    </aside>

    <section className="agent-main">
      <header className="agent-topbar"><div><span className="agent-online"><i /> SKUFlow Agent 在线</span><h1>{task && task.productName !== PENDING_PRODUCT_NAME ? task.productName : phase === 'idle' ? '新对话' : '创建商品上新任务'}</h1></div><div className="agent-model"><span>百炼 Function Calling</span><b>qwen3.8-max · 工具已开启</b></div></header>

      <div className={`agent-chat-layout ${phase === 'idle' ? 'idle' : ''}`}>
        <section className="agent-thread" aria-label="Agent 对话">
          <div className="agent-date">今天 · Agent 工作区</div>
          {messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}>
            <span className="chat-avatar">{message.role === 'agent' ? 'AI' : '林'}</span>
            <div><p>{message.text}</p>{message.meta && <small>{message.meta}</small>}</div>
          </article>)}

          {phase === 'loading' && <div className="agent-running-card"><span className="agent-spinner" /><div><b>{busyLabel}</b><small>我会根据任务状态继续上次的工作。</small></div></div>}

          {phase === 'intake' && <div className="chat-action-card intake"><div className="action-card-head"><span>你只需要提供这些</span><b>目标市场、平台和原始资料</b><p>商品名称、属性、标题和卖点都由 Agent 后续自动生成。</p></div><div className="embedded-intake"><TaskIntake onNext={handleIntakeComplete} agentManaged /></div></div>}

          {phase === 'resume' && task && <div className="chat-action-card resume"><div className="resume-symbol">↻</div><div><span>可继续的任务</span><h3>{task.productName}</h3><p>{task.platforms.map((id) => platformNames.get(id) ?? id).join('、')} · {task.markets.join('、')}</p></div><div className="resume-actions"><button className="ghost" type="button" onClick={() => void newConversation()}>新建任务</button><button className="primary" type="button" onClick={resumeTask}>继续处理 →</button></div></div>}

          {phase === 'processing' && <div className="agent-running-card"><span className="agent-spinner" /><div><b>{busyLabel}</b><small>Agent 正在调用商品理解和平台适配工具，完成后会主动通知你。</small></div><em>自动执行中</em></div>}

          {toolRuns.length > 0 && <div className="agent-tool-trace"><div><span>实时工具调用</span><b>{toolRuns.filter((run) => run.status === 'COMPLETED').length}/{toolRuns.length} 已完成</b></div><ol>{toolRuns.map((run) => <li className={run.status.toLowerCase()} key={run.id}><i>{run.status === 'COMPLETED' ? '✓' : run.status === 'FAILED' ? '!' : '↻'}</i><span>{toolLabels[run.name]}</span><small>{run.status === 'COMPLETED' ? '执行完成' : run.status === 'FAILED' ? '执行失败' : '执行中'}</small></li>)}</ol></div>}

          {phase === 'conflict' && passport && <div className="chat-action-card checkpoint warning"><div className="checkpoint-icon">!</div><div><span>流程已暂停</span><h3>{openConflictCount} 项属性冲突需要你确认</h3><p>这些决定会同步影响各平台 Listing，Agent 不会自作主张。</p></div><button type="button" onClick={() => setConflictOpen(true)}>打开确认卡</button></div>}

          {phase === 'listing' && passport && <div className="chat-action-card listing-summary"><div className="action-card-head"><span>LISTING CHECKPOINT</span><b>各平台中文审校稿</b><p>Agent 已按平台字段分别填写。默认只看结果，需要时再展开字段详情。</p></div><div className="platform-review-list">{passport.platformDrafts.map((draft) => {
            const payload = isListingDraftPayload(draft.payload) ? draft.payload : null;
            return <article key={draft.id}><span>{platformNames.get(draft.platformId) ?? draft.platformId}</span><div><b>{payload ? listingTitle(payload) : '等待生成'}</b><small>{draft.market} · {draft.validationIssues.length ? `${draft.validationIssues.length} 项待处理` : '校验通过'}</small></div><em className={draft.status === 'APPROVED' ? 'done' : ''}>{draft.status === 'APPROVED' ? '已确认' : '待审核'}</em></article>;
          })}</div><button className="primary card-primary" type="button" onClick={() => setListingOpen(true)}>审核 {passport.platformDrafts.length} 个平台稿 →</button></div>}

          {phase === 'assets' && <div className="chat-action-card checkpoint success"><div className="checkpoint-icon">▣</div><div><span>视觉素材已准备</span><h3>{selectedAssets.length ? `已选择 ${selectedAssets.length} 个方案` : '请选择要交付的图片'}</h3><p>候选图会与已确认的商品事实和 Listing 保持一致。</p></div><button type="button" onClick={() => setAssetOpen(true)}>打开选图卡</button></div>}

          {phase === 'publish' && <div className="chat-action-card checkpoint final"><div className="checkpoint-icon">↗</div><div><span>最终人工门禁</span><h3>上架包已准备完成</h3><p>只有你明确确认后，Agent 才会调用发布工具。</p></div><button type="button" onClick={() => setPublishOpen(true)}>查看并确认发布</button></div>}

          {phase === 'complete' && <div className="chat-action-card completed"><span>✓</span><div><small>交付完成</small><h3>{publishedCount} 个平台草稿已创建</h3><p>任务、商品事实、人工决策和发布结果均已保留追溯信息。</p></div><button className="primary" type="button" onClick={() => void newConversation()}>处理下一个商品</button></div>}

          {error && <div className="chat-error" role="alert"><b>任务暂停</b><span>{error}</span>{task && <button type="button" onClick={resumeTask}>重试当前步骤</button>}</div>}
          <div ref={threadEnd} />
        </section>

        {phase !== 'idle' && <aside className="agent-context">
          <div className="context-head"><span>任务进度</span><b>{phase === 'complete' ? '已完成' : '进行中'}</b></div>
          <ol className="agent-progress">{['接收资料', '商品理解', 'Listing 审核', '视觉选择', '发布交付'].map((label, index) => <li className={index < currentStep || phase === 'complete' ? 'done' : index === currentStep ? 'current' : ''} key={label}><span>{index < currentStep || phase === 'complete' ? '✓' : index + 1}</span><div><b>{label}</b><small>{index < currentStep || phase === 'complete' ? '已完成' : index === currentStep ? '当前阶段' : '由 Agent 继续'}</small></div></li>)}</ol>
          {task && <div className="context-summary"><span>当前商品</span><h3>{task.productName}</h3><div><b>{visibleFacts.length}</b><small>属性</small><b>{openConflictCount}</b><small>冲突</small><b>{approvedCount}</b><small>已审核</small></div><p>{task.platforms.map((id) => platformNames.get(id) ?? id).join(' · ')}</p></div>}
          {passport && <details className="agent-evidence"><summary>查看商品事实与证据</summary><div>{visibleFacts.slice(0, 12).map((fact) => <p key={fact.id}><b>{fact.label}</b><span>{displayValue(fact.value, fact.unit)}</span></p>)}{visibleFacts.length > 12 && <small>还有 {visibleFacts.length - 12} 项属性已收起</small>}</div></details>}
          <div className="context-safety"><span>◈</span><div><b>人工门禁已开启</b><small>冲突与发布永远需要你确认</small></div></div>
        </aside>}
      </div>

      <footer className="agent-composer"><button type="button" aria-label="新建上新会话" onClick={() => { if (phase !== 'idle') void newConversation(); }}>+</button><input value={composer} disabled={phase === 'processing'} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void sendMessage(); }} placeholder={phase === 'processing' ? 'Agent 正在执行工具…' : phase === 'idle' ? '告诉 Agent 你想做什么…' : '直接告诉 Agent 你的要求…'} /><button className="send" type="button" onClick={() => void sendMessage()} disabled={!composer.trim() || phase === 'processing'}>↑</button></footer>
    </section>

    {conflictOpen && passport && <ConflictDialog passport={passport} busy={actionBusy} manualValue={manualConflictValue} onManualValue={setManualConflictValue} onResolve={resolveConflict} onClose={() => setConflictOpen(false)} />}
    {listingOpen && task && <AgentDialog eyebrow="AGENT CHECKPOINT · LISTING REVIEW" title="审核各平台中文 Listing" onClose={() => { setListingOpen(false); void refreshAfterListing(); }} wide><div className="embedded-listing"><ListingWorkspace task={task} onAssets={proceedToAssets} /></div></AgentDialog>}
    {assetOpen && <AssetDialog selected={selectedAssets} onToggle={toggleAsset} onConfirm={confirmAssets} onClose={() => setAssetOpen(false)} />}
    {publishOpen && task && passport && <PublishDialog task={task} passport={passport} selectedAssets={selectedAssets} busy={actionBusy} onPublish={publish} onClose={() => setPublishOpen(false)} />}
  </main>;
}
