'use client';
import { MediaOrderReview } from '@/components/media-order-review';
import { VideoConversation } from '@/components/video-conversation';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import Image from 'next/image';
import { ListingWorkspace } from '@/components/listing-workspace';
import { TaskIntake } from '@/components/task-intake';
import { inferConversationTargets } from '@/lib/agents/intake-targets';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import type {
  AgentModelMessage,
  AgentOrchestratorResponse,
  AgentToolCall,
  AgentToolName,
  AgentWorkflowState,
} from '@/lib/domain/agent-orchestrator';
import type {
  AgentConversationRecord,
  ConversationAttachment,
  ConversationMessage,
  ConversationSummary,
} from '@/lib/domain/conversation';
import type { FactConflict, FactValue, ProductPassport } from '@/lib/domain/product-passport';
import type { GeneratedAsset } from '@/lib/domain/generated-asset';
import { PENDING_PRODUCT_NAME, type TaskSnapshot } from '@/lib/domain/task';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { platformRegistry } from '@/lib/platforms/registry';

type AgentPhase = 'loading' | 'idle' | 'intake' | 'resume' | 'processing' | 'conflict' | 'listing' | 'assets' | 'publish' | 'complete' | 'error';

type ChatMessage = ConversationMessage;

const DEFAULT_RAIL_WIDTH = 272;
const MIN_RAIL_WIDTH = 220;
const MAX_RAIL_WIDTH = 420;
const RAIL_WIDTH_STORAGE_KEY = 'skuflow-agent-rail-width';
const COMPOSER_FILE_ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf,.xlsx,.xls,.csv,.txt,.docx';
const MAX_COMPOSER_FILES = 12;
const MAX_COMPOSER_TOTAL_SIZE = 40 * 1024 * 1024;

interface ToolRun {
  id: string;
  name: AgentToolName;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function RichMessageContent({ message }: { message: ChatMessage }) {
  return <>
    {message.text && <p>{message.text}</p>}
    {message.attachments && message.attachments.length > 0 && <div className="rich-file-list">
      {message.attachments.map((file) => {
        const image = file.contentType.startsWith('image/');
        return <article className="rich-file" key={file.fileId}>
          {image
            ? <Image src={`/api/tasks/${file.taskId}/files/${file.fileId}`} alt={file.name} width={58} height={58} unoptimized />
            : <span className="rich-file-icon">{file.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'}</span>}
          <div><b>{file.name}</b><small>{formatBytes(file.size)} · 已安全上传</small></div><em>✓</em>
        </article>;
      })}
    </div>}
    {message.items && message.items.length > 0 && <div className={`rich-item-list ${message.kind ?? 'text'}`}>
      {message.items.map((item) => <article key={item.id}><div><span>{item.label}</span>{item.status && <em>{item.status}</em>}</div><b>{item.value}</b>{item.detail && <small>{item.detail}</small>}</article>)}
    </div>}
    {message.meta && <small>{message.meta}</small>}
  </>;
}

const initialMessages: ChatMessage[] = [{
  id: 'welcome',
  role: 'agent',
  text: '你好，林晓雨。今天想上新什么商品？',
  meta: '直接描述需求，也可以先附上图片、表格或说明文档',
}];

function messageId(): string {
  return `message_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function taskAttachments(task: TaskSnapshot): ConversationAttachment[] {
  return task.files.map((file) => ({
    taskId: task.id,
    fileId: file.id,
    name: file.name,
    contentType: file.contentType,
    size: file.size,
  }));
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

function assetKindLabel(kind: GeneratedAsset['kind']): string {
  return {
    HERO: '商品主图',
    LIFESTYLE: '场景图',
    DETAIL: '细节图',
    MODEL: '模特展示',
    FEATURE: '卖点视觉',
    SCALE: '尺寸感展示',
    PACKAGING: '包装展示',
    VIDEO: '商品视频',
  }[kind];
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

function ConflictConversationCard({ passport, busy, manualValue, onManualValue, onResolve }: {
  passport: ProductPassport;
  busy: boolean;
  manualValue: string;
  onManualValue: (value: string) => void;
  onResolve: (conflict: FactConflict, candidateId?: string) => void;
}) {
  const conflicts = passport.conflicts.filter((item) => item.status === 'OPEN');
  const conflict = conflicts[0];
  if (!conflict) return null;
  const label = passport.facts.find((fact) => fact.key === conflict.factKey)?.label ?? conflict.factKey;
  return <article className="chat-message agent conflict-conversation">
    <span className="chat-avatar">AI</span>
    <div className="conflict-conversation-card">
      <header><span>需要你确认 · 还剩 {conflicts.length} 项</span><h3>{label} 的真实值是哪一个？</h3><p>图片和文档给出了不同答案。我不会擅自覆盖，你确认后我再继续处理。</p></header>
      <div className="conflict-quick-replies">{conflict.candidates.map((candidate) => <button type="button" disabled={busy} key={candidate.id} onClick={() => onResolve(conflict, candidate.id)}>
        <small>{sourceLabel(candidate.sourceKind)}</small>
        <b>{displayValue(candidate.value, candidate.unit)}</b>
        <span>{candidate.sourceLabel}</span>
        <strong>确认采用</strong>
      </button>)}</div>
      <div className="conflict-custom-reply"><label htmlFor="conflict-custom-value">以上都不对，直接告诉我真实值</label><div><input id="conflict-custom-value" value={manualValue} onChange={(event) => onManualValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && manualValue.trim() && !busy) onResolve(conflict); }} placeholder="输入真实值" maxLength={240} /><button type="button" disabled={busy || !manualValue.trim()} onClick={() => onResolve(conflict)}>{busy ? '记录中…' : '发送确认'}</button></div></div>
    </div>
  </article>;
}

function AssetConversationCard({ assets, selected, onToggle, onConfirm }: {
  assets: GeneratedAsset[];
  selected: string[];
  onToggle: (id: string) => void;
  onConfirm: () => void;
}) {
  const completed = assets.filter((asset) => asset.kind !== 'VIDEO' && asset.status === 'COMPLETED' && asset.imageUrl);
  return <div className="asset-conversation-card">
    <header><span>需要你选择 · 视觉素材</span><h3>我为这个商品生成了 {completed.length} 张候选图</h3><p>请选择要进入交付包的图片。你可以选择一张或多张。</p></header>
    <div className="agent-asset-grid">{completed.map((asset) => <button type="button" className={selected.includes(asset.id) ? 'selected' : ''} onClick={() => onToggle(asset.id)} key={asset.id}>
      <span className="agent-asset-preview"><Image src={asset.imageUrl!} alt={asset.title} width={512} height={512} unoptimized /><i>{selected.includes(asset.id) ? '✓' : '+'}</i><b>{assetKindLabel(asset.kind)}</b></span>
      <strong>{asset.title}</strong><small>{asset.note}</small><em>{asset.model}</em>
    </button>)}</div>
    <div className="asset-conversation-hint"><span>↳</span><div><b>不满意这批素材？</b><p>直接在下方对话框告诉我修改要求，例如“换成户外场景，不要模特”，我会重新规划并生成。</p></div></div>
    <footer><span>已选择 {selected.length} 项</span><button className="primary" type="button" disabled={selected.length === 0} onClick={onConfirm}>确认已选素材并继续</button></footer>
  </div>;
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
  const shopifyCount = approved.filter((draft) => draft.platformId === 'shopify').length;
  const mockCount = approved.length - shopifyCount;
  const deliveryMode = [shopifyCount ? 'Shopify Dev Store 测试草稿' : '', mockCount ? '其他平台本地 Mock' : ''].filter(Boolean).join(' + ');
  return <AgentDialog eyebrow="FINAL CHECKPOINT · DELIVERY" title="确认发布这个商品？" onClose={onClose}>
    <div className="publish-confirm-product"><span>↗</span><div><b>{task.productName}</b><small>{approved.length} 个平台 Listing · {selectedAssets.length} 个视觉方案</small></div></div>
    <dl className="publish-confirm-list"><div><dt>目标平台</dt><dd>{approved.map((draft) => platformRegistry.find((item) => item.id === draft.platformId)?.shortName ?? draft.platformId).join('、')}</dd></div><div><dt>目标市场</dt><dd>{[...new Set(approved.map((draft) => draft.market))].join('、')}</dd></div><div><dt>审核版本</dt><dd>简体中文审校稿</dd></div><div><dt>发布模式</dt><dd>{deliveryMode || '测试草稿'}</dd></div></dl>
    <div className="publish-warning"><b>安全测试模式</b><span>{shopifyCount ? 'Shopify 将调用官方 Dev Store 接口，只创建 DRAFT 商品，不会公开上架；' : ''}{mockCount ? '其他平台仍只创建本地 Mock 草稿；' : ''}若测试店铺未配置，Agent 会暂停并提示所需连接信息。</span></div>
    <div className="dialog-footer"><button className="ghost" type="button" onClick={onClose}>再检查一下</button><button className="primary" type="button" disabled={busy || approved.length === 0} onClick={onPublish}>{busy ? '发布中…' : `确认并创建 ${approved.length} 个草稿`}</button></div>
  </AgentDialog>;
}

function DeleteConversationDialog({ conversation, busy, onDelete, onClose }: {
  conversation: ConversationSummary;
  busy: boolean;
  onDelete: () => void;
  onClose: () => void;
}) {
  return <AgentDialog eyebrow="CONVERSATION" title="删除这个会话？" onClose={busy ? () => undefined : onClose}>
    <div className="delete-conversation-copy">
      <span>×</span>
      <div><b>{conversation.title}</b><p>删除后，这条对话及其 Agent 记忆将不再显示；已经创建的商品任务和上传资料会继续保留。</p></div>
    </div>
    <div className="dialog-footer"><button className="ghost" type="button" disabled={busy} onClick={onClose}>取消</button><button className="danger" type="button" disabled={busy} onClick={onDelete}>{busy ? '正在删除…' : '确认删除会话'}</button></div>
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
  const [publishOpen, setPublishOpen] = useState(false);
  const [manualConflictValue, setManualConflictValue] = useState('');
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [mediaGuidance,setMediaGuidance] = useState('');
  const mediaPlanRef = useRef<string | null>(null);
  const [mediaPlanReady,setMediaPlanReady] = useState(false);
  const [videoRevision,setVideoRevision] = useState(0);
  const [generatedAssets, setGeneratedAssets] = useState<GeneratedAsset[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<ConversationSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [contextOpen, setContextOpen] = useState(false);
  const threadEnd = useRef<HTMLDivElement>(null);
  const composerFileInput = useRef<HTMLInputElement>(null);
  const modelHistory = useRef<AgentModelMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>(initialMessages);
  const toolRunsRef = useRef<ToolRun[]>([]);
  const selectedAssetsRef = useRef<string[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const railWidthRef = useRef(DEFAULT_RAIL_WIDTH);
  const railResizeStart = useRef<{ x: number; width: number } | null>(null);

  const platformNames = useMemo(() => new Map(platformRegistry.map((item) => [item.id, item.shortName])), []);
  const currentStep = phase === 'conflict' ? 1 : phase === 'listing' ? 2 : phase === 'assets' ? 3 : phase === 'publish' || phase === 'complete' ? 4 : phase === 'processing' ? progressStep : 0;

  const append = (
    role: ChatMessage['role'],
    text: string,
    meta?: string,
    rich: Partial<Pick<ChatMessage, 'kind' | 'attachments' | 'items'>> = {},
  ) => {
    const next = [...messagesRef.current, { id: messageId(), role, text, ...(meta ? { meta } : {}), ...rich }].slice(-200);
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

  const fetchGeneratedAssets = async (taskId: string): Promise<GeneratedAsset[]> => {
    const payload = await responseJson<{ assets: GeneratedAsset[] }>(await fetch(`/api/tasks/${taskId}/generated-assets`), '视觉素材读取失败');
    const videos=await responseJson<{jobs:any[]}>(await fetch(`/api/tasks/${taskId}/videos`),'视频素材读取失败');
    return [...payload.assets,...videos.jobs.filter(j=>j.status==='SUCCEEDED').map(j=>({id:j.id,taskId,sourceFileId:j.plan.sourceFileId,batchId:'video',kind:'VIDEO' as const,title:j.plan.title,note:j.plan.shots.join('；'),model:'wan2.7-i2v',status:'COMPLETED' as const,width:null,height:null,error:null,createdAt:'',completedAt:null,imageUrl:j.videoUrl}))];
  };

  const updateConversationList = (conversation: AgentConversationRecord | ConversationSummary) => {
    setConversations((current) => current.some((item) => item.id === conversation.id)
      ? current.map((item) => item.id === conversation.id ? conversation : item)
      : [conversation, ...current]);
  };

  const applyConversation = async (conversation: AgentConversationRecord) => {
    setContextOpen(false);
    conversationIdRef.current = conversation.id;
    setConversationId(conversation.id);
    const storedMessages = conversation.messages.length ? conversation.messages : initialMessages;
    messagesRef.current = storedMessages.filter((message) => message.kind !== 'tool');
    const removedInternalLogs = messagesRef.current.length !== storedMessages.length;
    setMessages(messagesRef.current);
    modelHistory.current = conversation.modelHistory;
    toolRunsRef.current = conversation.toolRuns;
    mediaPlanRef.current=null;setMediaPlanReady(false);setMediaGuidance('');
    selectedAssetsRef.current = conversation.selectedAssetIds;
    setSelectedAssets(conversation.selectedAssetIds);
    setPendingFiles([]);
    if (composerFileInput.current) composerFileInput.current.value = '';
    setError(''); setComposer('');
    setPublishOpen(false);
    updateConversationList(conversation);
    if (!conversation.taskId) {
      const intakeStarted = conversation.toolRuns.some((run) => run.name === 'start_listing_workflow' && run.status === 'COMPLETED');
      setTask(null); setPassport(null); setGeneratedAssets([]); setPhase(intakeStarted ? 'intake' : 'idle'); setProgressStep(0);
      if (removedInternalLogs) await persistConversation(null, conversation.status);
      return;
    }
    const [loadedTask, loadedPassport, loadedAssets] = await Promise.all([
      fetchTask(conversation.taskId), fetchPassport(conversation.taskId), fetchGeneratedAssets(conversation.taskId),
    ]);
    setTask(loadedTask); setPassport(loadedPassport); setGeneratedAssets(loadedAssets);
    let conversationUpgraded = removedInternalLogs;
    const validAssetIds = new Set(loadedAssets.filter((asset) => asset.status === 'COMPLETED').map((asset) => asset.id));
    const validSelections = conversation.selectedAssetIds.filter((id) => validAssetIds.has(id));
    if (validSelections.length !== conversation.selectedAssetIds.length) {
      selectedAssetsRef.current = validSelections;
      setSelectedAssets(validSelections);
      conversationUpgraded = true;
    }
    if (loadedTask.files.length > 0 && !messagesRef.current.some((message) => message.attachments?.some((file) => file.taskId === loadedTask.id))) {
      const historyAttachment: ChatMessage = {
        id: messageId(), role: 'user', text: `本会话已提交 ${loadedTask.files.length} 份商品资料`, meta: '历史资料记录',
        kind: 'files', attachments: taskAttachments(loadedTask),
      };
      messagesRef.current = [...messagesRef.current, historyAttachment].slice(-200);
      setMessages(messagesRef.current);
      conversationUpgraded = true;
    }
    const openConflicts = loadedPassport.conflicts.some((item) => item.status === 'OPEN');
    const published = loadedPassport.platformDrafts.some((draft) => draft.status === 'DRAFT_CREATED');
    const generated = loadedPassport.platformDrafts.some((draft) => isListingDraftPayload(draft.payload));
    const allApproved = loadedPassport.platformDrafts.length > 0 && loadedPassport.platformDrafts.every((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
    setPhase(published ? 'complete' : openConflicts ? 'conflict' : allApproved ? (conversation.selectedAssetIds.length ? 'publish' : 'assets') : generated ? 'listing' : 'resume');
    if (conversationUpgraded) await persistConversation(loadedTask.id, conversation.status);
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

  useEffect(() => {
    const storedWidth = Number(window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY));
    if (!Number.isFinite(storedWidth) || storedWidth < MIN_RAIL_WIDTH || storedWidth > MAX_RAIL_WIDTH) return;
    const timer = window.setTimeout(() => {
      railWidthRef.current = storedWidth;
      setRailWidth(storedWidth);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const resizeRail = (nextWidth: number, remember = false) => {
    const width = Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(nextWidth)));
    railWidthRef.current = width;
    setRailWidth(width);
    if (remember) window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(width));
  };

  const addComposerFiles = (incoming: FileList) => {
    const supported = new Set(COMPOSER_FILE_ACCEPT.split(',').map((item) => item.slice(1)));
    const candidates = Array.from(incoming);
    const unsupported = candidates.find((file) => !supported.has(file.name.split('.').pop()?.toLowerCase() ?? ''));
    if (unsupported) return setError(`不支持的文件类型：${unsupported.name}`);
    const known = new Set(pendingFiles.map((file) => `${file.name}:${file.size}`));
    const merged = [...pendingFiles, ...candidates.filter((file) => !known.has(`${file.name}:${file.size}`))].slice(0, MAX_COMPOSER_FILES);
    if (merged.reduce((sum, file) => sum + file.size, 0) > MAX_COMPOSER_TOTAL_SIZE) {
      return setError('全部附件总大小不能超过 40 MB');
    }
    setPendingFiles(merged);
    setError(candidates.length + pendingFiles.length > MAX_COMPOSER_FILES ? `一次最多上传 ${MAX_COMPOSER_FILES} 个文件` : '');
  };

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
      return setPhase(state.selectedAssetCount > 0 ? 'publish' : state.generatedAssetCount > 0 ? 'assets' : 'processing');
    }
    setPhase('resume');
  };

  const markToolRun = (call: AgentToolCall, status: ToolRun['status']) => {
    const existing = toolRunsRef.current.find((item) => item.id === call.id);
    const next = existing
      ? toolRunsRef.current.map((item) => item.id === call.id ? { ...item, status } : item)
      : [...toolRunsRef.current, { id: call.id, name: call.function.name, status }].slice(-12);
    toolRunsRef.current = next;
  };

  const executeTool = async (
    call: AgentToolCall,
    currentTask: TaskSnapshot | null,
    publishApproved: boolean,
    attachmentFiles: File[],
    requestText: string,
  ): Promise<{ result: Record<string, unknown>; checkpoint: boolean; completed?: boolean; task?: TaskSnapshot; consumedAttachments?: boolean }> => {
    const name = call.function.name;
    markToolRun(call, 'RUNNING');
    try {
      if (name === 'inspect_chat_attachments') {
        if (attachmentFiles.length === 0) throw new Error('本轮没有可读取的聊天附件');
        setBusyLabel('Agent 正在读取本轮附件…');
        const body = new FormData();
        attachmentFiles.forEach((file) => body.append('files', file));
        const payload = await responseJson<Record<string, unknown>>(await fetch('/api/agent/inspect-attachments', { method: 'POST', body }), '附件读取失败');
        // Keep the source files available if the seller asks to list them next.
        markToolRun(call, 'COMPLETED');
        return { result: payload, checkpoint: false, consumedAttachments: true };
      }
      if (name === 'create_listing_task_from_attachments') {
        if (currentTask) throw new Error('当前会话已经绑定商品任务');
        if (attachmentFiles.length === 0) throw new Error('本轮没有可用于创建任务的附件');
        setBusyLabel('Agent 正在安全保存资料并创建商品任务…');
        const body = new FormData();
        const targets = inferConversationTargets(modelHistory.current);
        if (!targets.platforms.length || !targets.markets.length) {
          throw new Error('请先明确目标平台和市场，现有附件会保留。');
        }
        body.set('platforms', JSON.stringify(targets.platforms));
        body.set('markets', JSON.stringify(targets.markets));
        body.set('request', requestText);
        attachmentFiles.forEach((file) => body.append('files', file));
        const payload = await responseJson<{
          task: TaskSnapshot;
          targeting: { platformSource: string; marketSource: string };
        }>(await fetch('/api/tasks', { method: 'POST', body }), '商品任务创建失败');
        const createdTask = payload.task;
        setTask(createdTask);
        setPassport(await fetchPassport(createdTask.id));
        setPendingFiles([]);
        if (composerFileInput.current) composerFileInput.current.value = '';
        const latestUser = [...messagesRef.current].reverse().find((message) => message.role === 'user');
        if (latestUser) {
          const next = messagesRef.current.map((message) => message.id === latestUser.id
            ? { ...message, kind: 'files' as const, items: undefined, attachments: taskAttachments(createdTask), meta: `${createdTask.files.length} 份资料 · 已安全上传` }
            : message);
          messagesRef.current = next;
          setMessages(next);
        }
        markToolRun(call, 'COMPLETED');
        return {
          result: {
            ok: true,
            taskId: createdTask.id,
            files: createdTask.files.length,
            platforms: createdTask.platforms,
            markets: createdTask.markets,
            targeting: payload.targeting,
          },
          checkpoint: false,
          task: createdTask,
          consumedAttachments: true,
        };
      }
      if (name === 'start_listing_workflow') {
        const targets = inferConversationTargets(modelHistory.current);
        if (attachmentFiles.length && targets.platforms.length && targets.markets.length) {
          markToolRun(call, 'COMPLETED');
          return executeTool({ ...call, function: { name: 'create_listing_task_from_attachments', arguments: '{}' } }, currentTask, publishApproved, attachmentFiles, requestText);
        }
        setPhase('intake');
        const missing = [!targets.platforms.length ? '目标平台' : '', !targets.markets.length ? '目标市场' : '', !attachmentFiles.length ? '商品资料' : ''].filter(Boolean);
        append('agent', `${attachmentFiles.length ? `已收到 ${attachmentFiles.length} 份商品资料，无需重复上传。` : ''}还需要确认${missing.join('、')}。你可以直接在对话里告诉我，也可以使用下方选择卡。`, '仅补充缺失信息');
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
        const conflicts = refreshed.passport.conflicts.filter((item) => item.status === 'OPEN');
        const count = conflicts.length;
        if (count === 0) throw new Error('当前没有待确认的商品属性冲突');
        setPhase('conflict');
        append('agent', `我发现 ${count} 处图文冲突，已经暂停自动执行。我们逐项确认，先从第一项开始。`, '等待你的回复', {
          kind: 'decision',
          items: conflicts.slice(0, 8).map((conflict) => ({
            id: conflict.id,
            label: refreshed.passport.facts.find((fact) => fact.key === conflict.factKey)?.label ?? conflict.factKey,
            value: conflict.candidates.map((candidate) => displayValue(candidate.value, candidate.unit)).join(' ↔ '),
            status: '待确认',
          })),
        });
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true, openConflicts: count }, checkpoint: true };
      }
      if (name === 'open_listing_review') {
        const refreshed = await refreshTaskState(currentTask.id);
        setPhase('listing');
        append('agent', `我已经生成 ${refreshed.passport.platformDrafts.length} 份平台中文审校稿。接下来我会在对话中逐个平台请你确认。`, '等待 Listing 审核', {
          kind: 'listing',
          items: refreshed.passport.platformDrafts.map((draft) => {
            const payload = isListingDraftPayload(draft.payload) ? draft.payload : null;
            return {
              id: draft.id,
              label: platformNames.get(draft.platformId) ?? draft.platformId,
              value: payload ? listingTitle(payload) : '等待生成',
              detail: `${draft.market} · 中文审校稿`,
              status: draft.status === 'APPROVED' ? '已确认' : '待审核',
            };
          }),
        });
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true, drafts: refreshed.passport.platformDrafts.length }, checkpoint: true };
      }
      if (name === 'generate_visual_assets' && /封面|排序|顺序|(?:视频|图片).*放.*第/.test(requestText)) {
        mediaPlanRef.current=null;setMediaPlanReady(false);setMediaGuidance(requestText);setPhase('publish');setPublishOpen(false);
        append('agent','请按最新要求重新安排封面与媒体顺序，并核对方案。','等待媒体编排确认');markToolRun(call,'COMPLETED');return {result:{ok:true,mediaReview:true},checkpoint:true};
      }
      if (name === 'generate_visual_assets' && /视频|video/i.test(requestText)) {
        const result=await responseJson<{job:{id:string}}>(await fetch(`/api/tasks/${currentTask.id}/videos`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({guidance:requestText})}),'视频方案规划失败');
        setVideoRevision(v=>v+1);setPhase('assets');
        append('agent','视频方案已放在当前对话中，请核对镜头、时长和清晰度，确认后启动生成。','等待视频方案确认',{kind:'assets'});
        markToolRun(call,'COMPLETED');return {result:{ok:true,videoPlanId:result.job.id},checkpoint:true};
      }
      if (name === 'generate_visual_assets') {
        setProgressStep(3); setBusyLabel('视觉策划 Agent 正在规划并生成适合这个商品的素材…');
        const customVisualRequest = /重新生成|再生成|重新规划|换一批|换成|想要.*(?:素材|图片|主图|场景)|增加.*(?:素材|图片)|生成.*(?:素材|图片)/.test(requestText);
        const payload = await responseJson<{
          assets: GeneratedAsset[];
          summary: { total: number; completed: number; failed: number };
        }>(await fetch(`/api/tasks/${currentTask.id}/generated-assets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: customVisualRequest, guidance: customVisualRequest ? requestText : null }),
        }), '视觉素材生成失败');
        setGeneratedAssets(payload.assets);
        selectedAssetsRef.current = [];
        setSelectedAssets([]);
        if (payload.summary.completed === 0) throw new Error('图像模型没有生成可用素材');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary }, checkpoint: false };
      }
      if (name === 'open_asset_selection') {
        const assets = await fetchGeneratedAssets(currentTask.id);
        const completed = assets.filter((asset) => asset.status === 'COMPLETED');
        if (completed.length === 0) throw new Error('没有可供选择的已生成素材');
        setGeneratedAssets(assets);
        setPhase('assets');
        append('agent', `我已经根据这个商品的类目、属性、目标平台和原始图片，动态规划并生成 ${completed.length} 张视觉素材。候选图已经放在当前对话中；不满意的话，直接在下方告诉我想怎么修改。`, '等待素材选择');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true }, checkpoint: true };
      }
      if (name === 'open_publish_confirmation') {
        if(currentTask.platforms.includes('shopify')) {
          setBusyLabel('Agent 正在安排商品封面与图片／视频顺序…');
          await responseJson(await fetch(`/api/tasks/${currentTask.id}/media-plan`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({selectedAssetIds:selectedAssetsRef.current,guidance:mediaGuidance})}),'媒体编排失败');
        }
        setPhase('publish'); setPublishOpen(!currentTask.platforms.includes('shopify'));
        mediaPlanRef.current=null;setMediaPlanReady(false);
        append('agent', '上架包已经准备完成。请做最后一次检查，只有你明确确认后我才会调用测试发布工具。Shopify 会创建未公开的 Dev Store 草稿。', '等待最终确认', {
          kind: 'publish',
          items: [{ id: currentTask.id, label: currentTask.productName, value: `${currentTask.platforms.length} 个目标平台`, detail: `${currentTask.markets.join('、')} · 测试草稿`, status: '待确认' }],
        });
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true }, checkpoint: true };
      }
      if (name === 'publish_mock_drafts') {
        if (!publishApproved) throw new Error('发布工具缺少本轮商家明确授权');
        setProgressStep(4); setBusyLabel('Agent 正在创建平台测试草稿…');
        const payload = await responseJson<{
          passport: ProductPassport;
          message?: string;
          results: Array<{ platformId: string; mode: 'SHOPIFY_DEV' | 'MOCK'; adminUrl?: string | null; warnings?: string[]; verification?: Array<{ field: string; status: string }> }>;
        }>(await fetch(`/api/tasks/${currentTask.id}/publish-mock`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({selectedAssetIds:selectedAssetsRef.current,mediaPlanId:mediaPlanRef.current}) }), '平台测试草稿创建失败');
        setPassport(payload.passport); setPublishOpen(false); setPhase('complete');
        const shopifyCreated = payload.results.filter((item) => item.mode === 'SHOPIFY_DEV').length;
        const warningCount = payload.results.reduce((count, item) => count + (item.warnings?.length ?? 0), 0);
        append('agent', `测试发布工具已完成，已创建 ${payload.results.length} 个平台草稿。${shopifyCreated ? `其中 ${shopifyCreated} 个已写入 Shopify Dev Store，保持未公开状态。` : ''}${warningCount ? `另有 ${warningCount} 条非阻塞提示可在发布记录中核对。` : ''}`, '发布记录已保存', {
          kind: 'publish',
          items: payload.passport.platformDrafts.filter((draft) => draft.status === 'DRAFT_CREATED').map((draft) => ({
            id: draft.id,
            label: platformNames.get(draft.platformId) ?? draft.platformId,
            value: '平台草稿已创建',
            detail: draft.market,
            status: '成功',
          })),
        });
        for (const result of payload.results.filter((item) => item.mode === 'SHOPIFY_DEV')) {
          append('agent', `Shopify 字段核对：${(result.verification ?? []).map((item) => `${item.field}：${item.status === 'MATCH' ? '一致' : item.status === 'MISMATCH' ? '不一致' : item.status === 'NOT_SYNCED' ? '未同步' : item.status === 'PENDING' ? '平台处理中' : '核对失败'}`).join('；')}。${result.warnings?.join('；') ?? ''}`, '发布核对结果');
        }
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
    options: { appendUser?: boolean; publishApproved?: boolean; resetHistory?: boolean; pendingFiles?: File[] } = {},
  ) => {
    if (options.resetHistory) modelHistory.current = [];
    let activeTask = currentTask;
    let activeFiles = options.pendingFiles ?? [];
    const attachmentContext = activeFiles.length > 0
      ? `\n\n[本轮聊天附件：${activeFiles.map((file) => `${file.name}（${file.type || '未知类型'}，${formatBytes(file.size)}）`).join('、')}。附件尚未创建商品任务，请严格根据用户意图决定是读取附件、创建上新任务、展示填写卡片或不调用工具。]`
      : '';
    const modelUserText = `${userText}${attachmentContext}`;
    if (options.appendUser !== false) append('user', userText, activeFiles.length ? `${activeFiles.length} 个聊天附件` : undefined, activeFiles.length ? {
      kind: 'files',
      items: activeFiles.map((file, index) => ({ id: `pending_${index}`, label: file.name, value: formatBytes(file.size), status: '随消息发送' })),
    } : {});
    const retainedHistory = modelHistory.current.length > 36
      ? modelHistory.current.filter((message) => message.role === 'user' || (message.role === 'assistant' && !message.toolCalls?.length)).slice(-20)
      : modelHistory.current;
    let history: AgentModelMessage[] = [...retainedHistory, { role: 'user', content: modelUserText }];
    setPhase('processing'); setBusyLabel('中央 Agent 正在判断下一步…'); setError('');
    try {
      for (let step = 0; step < 10; step += 1) {
        const payload = await responseJson<AgentOrchestratorResponse>(await fetch('/api/agent/orchestrate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            taskId: activeTask?.id,
            messages: history,
            selectedAssetIds: selectedAssetsRef.current,
            publishApproved: options.publishApproved === true,
            intakePresented: phase === 'intake' || toolRunsRef.current.some((run) => run.name === 'start_listing_workflow' && run.status === 'COMPLETED'),
            pendingAttachmentCount: activeFiles.length,
            requireAction: activeTask !== null,
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
          await persistConversation(activeTask?.id ?? null, payload.state.publishedDraftCount > 0 ? 'COMPLETED' : 'ACTIVE');
          return;
        }
        modelHistory.current = history;
        const execution = await executeTool(call, activeTask, options.publishApproved === true, activeFiles, userText);
        if (execution.task) activeTask = execution.task;
        if (execution.consumedAttachments) activeFiles = [];
        history = [...history, {
          role: 'tool',
          toolCallId: call.id,
          name: call.function.name,
          content: JSON.stringify(execution.result),
        }];
        modelHistory.current = history;
        await persistConversation(activeTask?.id ?? null, execution.completed ? 'COMPLETED' : 'ACTIVE');
        // A successful publication already supplies the final result. Do not
        // let a redundant model response turn a completed delivery into an error.
        if (execution.completed || execution.checkpoint) return;
      }
      throw new Error('Agent 连续执行步骤过多，已安全暂停');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Agent 执行失败';
      setError(message); setPhase('error');
      append('agent', `我在执行工具时遇到了问题：${message}`, '任务已安全暂停');
      await persistConversation(activeTask?.id ?? null).catch(() => undefined);
    }
  };

  const handleIntakeComplete = async (createdTask: TaskSnapshot) => {
    setPendingFiles([]);
    if (composerFileInput.current) composerFileInput.current.value = '';
    setTask(createdTask);
    setPassport(await fetchPassport(createdTask.id));
    toolRunsRef.current = [];
    append('user', `已上传 ${createdTask.files.length} 份同一商品资料`, `${createdTask.platforms.map((id) => platformNames.get(id) ?? id).join('、')} · ${createdTask.markets.join('、')}`, {
      kind: 'files',
      attachments: taskAttachments(createdTask),
    });
    await persistConversation(createdTask.id);
    await runAgentTurn(
      createdTask,
      `已提交 ${createdTask.files.length} 份同一商品资料，目标平台：${createdTask.platforms.map((id) => platformNames.get(id) ?? id).join('、')}。请自主完成内部步骤，只在需要我决定时暂停。`,
      { appendUser: false },
    );
  };

  const recheckShopify = async () => {
    if(!task)return;
    try {const data=await responseJson<{passport:ProductPassport;results:Array<{market:string;verification:Array<{field:string;status:string}>}>}>(await fetch(`/api/tasks/${task.id}/verify-shopify`,{method:'POST'}),'Shopify 回读失败');setPassport(data.passport);for(const r of data.results)append('agent',`${r.market}草稿核对：${r.verification.map(v=>`${v.field}：${v.status==='MATCH'?'一致':v.status==='PENDING'?'处理中':'需要检查'}`).join('；')}`,'回读核对');await persistConversation(task.id,'COMPLETED');}catch(e){append('agent',`核对失败：${(e as Error).message}。已创建的商品不受影响。`);}
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
      const label = passport?.facts.find((fact) => fact.key === conflict.factKey)?.label ?? conflict.factKey;
      append('user', `已确认商品属性：${label}`, '人工决策已记录', {
        kind: 'decision',
        items: [{ id: conflict.id, label, value: chosen, status: '已确认' }],
      });
      const remaining = payload.passport.conflicts.filter((item) => item.status === 'OPEN');
      if (remaining.length === 0) {
        await runAgentTurn(task, '商品属性冲突已经全部由我确认，请继续自动处理。', { appendUser: false });
      } else {
        const nextLabel = payload.passport.facts.find((fact) => fact.key === remaining[0].factKey)?.label ?? remaining[0].factKey;
        append('agent', `已记录“${label}”的确认结果。接下来请确认“${nextLabel}”。`, `还剩 ${remaining.length} 项冲突`);
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
    await refreshAfterListing();
    if (task) await runAgentTurn(task, '我已确认所有平台 Listing，请继续。', { appendUser: false });
  };

  const confirmAssets = async () => {
    const available=task?await fetchGeneratedAssets(task.id):generatedAssets;
    setGeneratedAssets(available);
    const chosen = available.filter((asset) => selectedAssetsRef.current.includes(asset.id));
    append('user', `已选择 ${chosen.length} 个视觉方案`, '素材选择已记录', {
      kind: 'assets',
      items: chosen.map((asset) => ({ id: asset.id, label: assetKindLabel(asset.kind), value: asset.title, detail: asset.note, status: '已选择' })),
    });
    if (task) await runAgentTurn(task, `我已选择 ${chosen.length} 个视觉方案，请继续。`, { appendUser: false });
  };

  const publish = async () => {
    if (!task) return;
    setActionBusy(true); setError('');
    try {
      append('user', '我已检查并确认发布', '最终授权已记录', {
        kind: 'publish',
        items: [{ id: task.id, label: task.productName, value: `${passport?.platformDrafts.filter((draft) => draft.status === 'APPROVED').length ?? 0} 个平台 Listing`, status: '已授权' }],
      });
      await runAgentTurn(task, '我已检查并明确确认发布，请调用发布工具。', { publishApproved: true, appendUser: false });
    } catch (caught) { setError(caught instanceof Error ? caught.message : '平台测试草稿创建失败'); }
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

  const removeConversation = async () => {
    if (!deleteCandidate) return;
    const target = deleteCandidate;
    setDeleteBusy(true); setError('');
    try {
      await responseJson<{ deleted: true }>(await fetch(`/api/conversations/${target.id}`, { method: 'DELETE' }), '会话删除失败');
      const targetIndex = conversations.findIndex((item) => item.id === target.id);
      const remaining = conversations.filter((item) => item.id !== target.id);
      setConversations(remaining);
      setDeleteCandidate(null);
      if (target.id === conversationIdRef.current) {
        conversationIdRef.current = null;
        setConversationId(null);
        const replacement = remaining[Math.min(Math.max(targetIndex, 0), remaining.length - 1)];
        if (replacement) {
          setPhase('loading'); setBusyLabel('正在打开相邻会话…');
          const payload = await responseJson<{ conversation: AgentConversationRecord }>(await fetch(`/api/conversations/${replacement.id}`), '会话读取失败');
          await applyConversation(payload.conversation);
        } else {
          await createConversation();
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '会话删除失败');
    } finally {
      setDeleteBusy(false);
    }
  };

  const sendMessage = async () => {
    const typedText = composer.trim();
    if (!typedText && pendingFiles.length === 0) return;
    const text = typedText || '请查看我随消息发送的这些附件。';
    const filesForTurn = [...pendingFiles];
    setComposer('');
    await runAgentTurn(task, text, { pendingFiles: filesForTurn });
  };

  const toggleAsset = (id: string) => {
    mediaPlanRef.current=null;setMediaPlanReady(false);
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
  const showWelcomeWorkspace = phase === 'idle' && messages.length === 1 && messages[0]?.id === 'welcome';

  const composerAttachments = pendingFiles.length > 0 && <div className="composer-attachments" aria-label="待上传附件">{pendingFiles.map((file, index) => <div className="composer-attachment" key={`${file.name}:${file.size}`}><span>{file.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'}</span><div><b>{file.name}</b><small>{formatBytes(file.size)}</small></div><button type="button" aria-label={`移除附件：${file.name}`} onClick={() => setPendingFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}</div>;

  const composerPlaceholder = phase === 'processing'
    ? 'Agent 正在执行工具...'
    : pendingFiles.length
      ? '告诉 Agent 要处理附件，还是用这些资料上新...'
      : phase === 'idle'
        ? '描述你要上新的商品、目标平台，或先上传商品资料...'
        : phase === 'assets'
          ? '不满意可以直接说：换成户外场景、不要模特...'
          : '直接告诉 Agent 你的要求...';

  return <main className="agent-shell agent-shell-v2" style={{ '--agent-rail-width': `${railWidth}px` } as CSSProperties}>
    <aside className="agent-rail" aria-label="SKUFlow 导航">
      <div className="agent-brand"><span>S</span><div><b>SKUFlow</b><small>Agentic Commerce</small></div></div>
      <nav className="agent-primary-nav" aria-label="工作区">
        <a className="active" href="#agent-workspace"><span>⌂</span>AI 上新</a>
        <a href="#conversation-list"><span>□</span>任务记录</a>
        <button type="button" disabled={phase === 'idle'} onClick={() => setContextOpen(true)}><span>◫</span>任务进度</button>
      </nav>
      <div className="agent-rail-label">最近对话</div>
      <div className="conversation-list" id="conversation-list">{conversations.map((item) => <div className={`conversation-item ${item.id === conversationId ? 'active' : ''}`} key={item.id}>
        <button className="conversation-open" type="button" disabled={phase === 'processing'} onClick={() => void loadConversation(item.id)}><span>{item.id === conversationId ? '◉' : '○'}</span><div><b>{item.title}</b><small>{item.status === 'COMPLETED' ? '已完成' : item.taskId ? '进行中' : '等待资料'}</small></div></button>
        <button className="conversation-delete" type="button" disabled={phase === 'processing'} aria-label={`删除会话：${item.title}`} title="删除会话" onClick={() => setDeleteCandidate(item)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 11H8L7 9Zm3 2v6h2v-6h-2Zm4 0v6h2v-6h-2Z" /></svg></button>
      </div>)}</div>
      <div className="agent-rail-links"><span>帮助中心</span><span>偏好设置</span></div>
      <div className="agent-rail-note"><i /> <b>Agent 自动推进</b><p>只在事实冲突、主观选择和最终发布时向你提问。</p></div>
      <div className="agent-user"><span>林</span><div><b>林晓雨</b><small>品牌运营</small></div></div>
      <button
        className="agent-rail-resizer"
        type="button"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话栏宽度"
        aria-valuemin={MIN_RAIL_WIDTH}
        aria-valuemax={MAX_RAIL_WIDTH}
        aria-valuenow={railWidth}
        title="拖动调整宽度，双击恢复默认"
        onDoubleClick={() => resizeRail(DEFAULT_RAIL_WIDTH, true)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          resizeRail(railWidthRef.current + (event.key === 'ArrowRight' ? 16 : -16), true);
        }}
        onPointerDown={(event) => {
          railResizeStart.current = { x: event.clientX, width: railWidthRef.current };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!railResizeStart.current) return;
          resizeRail(railResizeStart.current.width + event.clientX - railResizeStart.current.x);
        }}
        onPointerUp={(event) => {
          if (!railResizeStart.current) return;
          railResizeStart.current = null;
          resizeRail(railWidthRef.current, true);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          railResizeStart.current = null;
          resizeRail(railWidthRef.current, true);
        }}
      ><span /></button>
    </aside>

    <section className="agent-main" id="agent-workspace">
      <header className="agent-topbar">
        <div><span className="agent-online"><i /> SKUFlow Agent</span><h1>{task && task.productName !== PENDING_PRODUCT_NAME ? task.productName : phase === 'idle' ? 'AI 上新工作台' : '创建商品上新任务'}</h1></div>
        <div className="agent-topbar-actions">
          {phase !== 'idle' && <div className="agent-model"><span>百炼</span><b>qwen3.8-max</b></div>}
          {phase !== 'idle' && <button className="context-toggle" type="button" aria-expanded={contextOpen} onClick={() => setContextOpen((open) => !open)}><span>{currentStep + 1}/5</span>任务进度</button>}
          <button className="topbar-new-chat" type="button" disabled={phase === 'processing'} onClick={() => void newConversation()}><span>+</span> 新建对话</button>
        </div>
      </header>

      <div className={`agent-chat-layout ${phase === 'idle' ? 'idle' : ''} ${contextOpen ? 'context-open' : ''}`}>
        <section className="agent-thread" aria-label="Agent 对话">
          {!showWelcomeWorkspace && <div className="agent-date">今天 · Agent 工作区</div>}
          {!showWelcomeWorkspace && messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}>
            <span className="chat-avatar">{message.role === 'agent' ? 'AI' : '林'}</span>
            <div className={message.kind && message.kind !== 'text' ? 'rich-message-bubble' : ''}><RichMessageContent message={message} /></div>
          </article>)}

          {showWelcomeWorkspace && <div className="agent-welcome-workspace">
            <div className="agent-welcome-copy"><small>欢迎使用 SKUFlow</small><h2>今天想上新什么商品？</h2><p>把商品图片、参数表和说明文档交给我，我会整理属性、生成各平台 Listing，并在关键节点请你确认。</p></div>
            <div className={`welcome-composer ${pendingFiles.length ? 'has-files' : ''}`}>
              <input ref={composerFileInput} className="visually-hidden" type="file" multiple accept={COMPOSER_FILE_ACCEPT} onChange={(event) => { if (event.target.files) addComposerFiles(event.target.files); event.currentTarget.value = ''; }} />
              {composerAttachments}
              <textarea rows={4} className="agent-composer-input" value={composer} disabled={phase === 'processing'} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={composerPlaceholder} />
              <div className="welcome-composer-toolbar">
                <div><span className="composer-mode">◇ 智能规划</span><button type="button" onClick={() => composerFileInput.current?.click()}>＋ 添加资料</button><button type="button" onClick={() => composerFileInput.current?.click()}>▧ 上传图片</button><button type="button" disabled title="即将支持">⌁ 语音消息</button></div>
                <small>{composer.length}/2000</small>
                <button className="send" type="button" aria-label="发送消息" onClick={() => void sendMessage()} disabled={(!composer.trim() && pendingFiles.length === 0) || phase === 'processing'}>↑</button>
              </div>
            </div>
            <div className="ready-prompt-title">从常用任务开始</div>
            <div className="agent-starters" aria-label="快速开始">
              <button type="button" onClick={() => setComposer('我想上新一款商品')}><span>＋</span><b>上新一款商品</b><small>上传商品资料，由 Agent 完成多平台上新流程</small></button>
              <button type="button" onClick={() => setComposer('请帮我检查这份商品资料')}><span>◎</span><b>分析商品资料</b><small>提取属性，并识别图片与文档中的事实冲突</small></button>
              <button type="button" onClick={() => setComposer('我想了解不同平台的 Listing 要求')}><span>▤</span><b>咨询平台规则</b><small>了解平台字段、内容规范与发布限制</small></button>
              <button type="button" onClick={() => setComposer('请帮我优化这款商品的 Listing')}><span>◇</span><b>优化 Listing</b><small>改写标题、卖点、描述与平台营销内容</small></button>
            </div>
          </div>}

          {phase === 'loading' && <div className="agent-running-card"><span className="agent-spinner" /><div><b>{busyLabel}</b><small>我会根据任务状态继续上次的工作。</small></div></div>}

          {phase === 'intake' && <div className="chat-action-card intake"><div className="action-card-head"><span>补充必要信息</span><b>只需确认尚未提供的信息</b><p>也可以直接在对话中补充，已有资料会继续使用。</p></div><div className="embedded-intake"><TaskIntake key={JSON.stringify(inferConversationTargets(modelHistory.current)) + pendingFiles.map((file) => file.name + file.size).join()} onNext={handleIntakeComplete} agentManaged initialFiles={pendingFiles} initialTargets={inferConversationTargets(modelHistory.current)} /></div></div>}

          {phase === 'resume' && task && <div className="chat-action-card resume"><div className="resume-symbol">↻</div><div><span>可继续的任务</span><h3>{task.productName}</h3><p>{task.platforms.map((id) => platformNames.get(id) ?? id).join('、')} · {task.markets.join('、')}</p></div><div className="resume-actions"><button className="ghost" type="button" onClick={() => void newConversation()}>新建任务</button><button className="primary" type="button" onClick={resumeTask}>继续处理 →</button></div></div>}

          {phase === 'processing' && <div className="agent-running-card"><span className="agent-spinner" /><div><b>{busyLabel}</b><small>Agent 正在调用商品理解和平台适配工具，完成后会主动通知你。</small></div><em>自动执行中</em></div>}

          {phase === 'conflict' && passport && <ConflictConversationCard passport={passport} busy={actionBusy} manualValue={manualConflictValue} onManualValue={setManualConflictValue} onResolve={resolveConflict} />}

          {phase === 'listing' && task && <article className="chat-message agent listing-conversation"><span className="chat-avatar">AI</span><ListingWorkspace task={task} onAssets={proceedToAssets} conversation /></article>}

          {task && ['assets','publish','complete'].includes(phase) && <article className="chat-message agent"><span className="chat-avatar">AI</span><VideoConversation taskId={task.id} revision={videoRevision} selected={selectedAssets} onToggle={toggleAsset} selectable={phase !== 'complete'}/></article>}
          {phase === 'assets' && <article className="chat-message agent asset-conversation"><span className="chat-avatar">AI</span><AssetConversationCard assets={generatedAssets} selected={selectedAssets} onToggle={toggleAsset} onConfirm={confirmAssets} /></article>}

          {phase === 'publish' && <button type="button" onClick={()=>{mediaPlanRef.current=null;setMediaPlanReady(false);setPublishOpen(false);setPhase('assets');}}>重新选择图片和视频</button>}
          {phase === 'publish' && task?.platforms.includes('shopify') && <article className="chat-message agent"><span className="chat-avatar">AI</span><MediaOrderReview taskId={task.id} selectedIds={selectedAssets} guidance={mediaGuidance} onInvalidated={()=>{mediaPlanRef.current=null;setMediaPlanReady(false);setPublishOpen(false);}} onConfirmed={id=>{mediaPlanRef.current=id;setMediaPlanReady(true);setPublishOpen(true);}}/></article>}
          {phase === 'publish' && <div className="chat-action-card checkpoint final"><div className="checkpoint-icon">↗</div><div><span>最终人工门禁</span><h3>上架包已准备完成</h3><p>只有你明确确认后，Agent 才会调用发布工具。</p></div><button type="button" disabled={Boolean(task?.platforms.includes('shopify') && !mediaPlanReady)} onClick={() => setPublishOpen(true)}>查看并确认发布</button></div>}

          {phase === 'complete' && <div className="chat-action-card completed"><span>✓</span><div><small>草稿已创建</small><h3>{publishedCount} 个平台草稿已创建</h3><p>任务、商品事实、人工决策和发布结果均已保留追溯信息。</p></div><button type="button" onClick={recheckShopify}>重新核对 Shopify</button><button className="primary" type="button" onClick={() => void newConversation()}>处理下一个商品</button></div>}

          {error && <div className="chat-error" role="alert"><b>任务暂停</b><span>{error}</span>{task && <button type="button" onClick={resumeTask}>重试当前步骤</button>}</div>}
          <div ref={threadEnd} />
        </section>

        {phase !== 'idle' && <>
          <button className="agent-context-scrim" type="button" aria-label="关闭任务进度" onClick={() => setContextOpen(false)} />
          <aside className="agent-context" aria-label="任务进度">
          <div className="context-head"><div><span>任务进度</span><b>{phase === 'complete' ? '已完成' : '进行中'}</b></div><button type="button" aria-label="关闭任务进度" onClick={() => setContextOpen(false)}>×</button></div>
          <ol className="agent-progress">{['接收资料', '商品理解', 'Listing 审核', '视觉选择', '发布交付'].map((label, index) => <li className={index < currentStep || phase === 'complete' ? 'done' : index === currentStep ? 'current' : ''} key={label}><span>{index < currentStep || phase === 'complete' ? '✓' : index + 1}</span><div><b>{label}</b><small>{index < currentStep || phase === 'complete' ? '已完成' : index === currentStep ? '当前阶段' : '由 Agent 继续'}</small></div></li>)}</ol>
          {task && <div className="context-summary"><span>当前商品</span><h3>{task.productName}</h3><div><b>{visibleFacts.length}</b><small>属性</small><b>{openConflictCount}</b><small>冲突</small><b>{approvedCount}</b><small>已审核</small></div><p>{task.platforms.map((id) => platformNames.get(id) ?? id).join(' · ')}</p></div>}
          {passport && <details className="agent-evidence"><summary>查看商品事实与证据</summary><div>{visibleFacts.slice(0, 12).map((fact) => <p key={fact.id}><b>{fact.label}</b><span>{displayValue(fact.value, fact.unit)}</span></p>)}{visibleFacts.length > 12 && <small>还有 {visibleFacts.length - 12} 项属性已收起</small>}</div></details>}
          <div className="context-safety"><span>◈</span><div><b>人工门禁已开启</b><small>冲突与发布永远需要你确认</small></div></div>
          </aside>
        </>}
      </div>

      {!showWelcomeWorkspace && <footer className={`agent-composer ${pendingFiles.length ? 'has-files' : ''}`}>
        <input ref={composerFileInput} className="visually-hidden" type="file" multiple accept={COMPOSER_FILE_ACCEPT} onChange={(event) => { if (event.target.files) addComposerFiles(event.target.files); event.currentTarget.value = ''; }} />
        {composerAttachments}
        <button className="composer-attach" type="button" aria-label="添加商品资料" title={task ? '当前会话已有商品任务' : '添加图片、表格或文档'} disabled={phase === 'processing' || task !== null} onClick={() => composerFileInput.current?.click()}>+</button>
        <textarea rows={1} className="agent-composer-input" value={composer} disabled={phase === 'processing'} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={composerPlaceholder} />
        <button className="send" type="button" onClick={() => void sendMessage()} disabled={(!composer.trim() && pendingFiles.length === 0) || phase === 'processing'}>↑</button>
      </footer>}
    </section>

    {publishOpen && task && passport && <PublishDialog task={task} passport={passport} selectedAssets={selectedAssets} busy={actionBusy} onPublish={publish} onClose={() => setPublishOpen(false)} />}
    {deleteCandidate && <DeleteConversationDialog conversation={deleteCandidate} busy={deleteBusy} onDelete={() => void removeConversation()} onClose={() => setDeleteCandidate(null)} />}
  </main>;
}
