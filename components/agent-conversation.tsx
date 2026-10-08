'use client';
import { trimVideo } from '@/lib/client/trim-video';

import type { AccountIdentity } from '@/lib/domain/identity';
import { MediaOrderReview } from '@/components/media-order-review';
import { VideoConversation } from '@/components/video-conversation';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import Image from 'next/image';
import { ListingWorkspace } from '@/components/listing-workspace';
import { BatchWorkspace } from '@/components/batch-workspace';
import { ShopPreferencesDialog } from '@/components/shop-preferences-dialog';
import { TaskIntake } from '@/components/task-intake';
import { TaskTargetEditor } from '@/components/task-target-editor';
import { inferConversationTargets } from '@/lib/agents/intake-targets';
import { compactAgentModelHistory } from '@/lib/agents/commerce-orchestrator';
import { restoreConversationAssetSnapshots, snapshotGeneratedImages } from '@/lib/agents/asset-history';
import { restoreConversationVideoRounds } from '@/lib/agents/video-history';
import { targetsFromSharedSelection } from '@/lib/platforms/market-options';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import type { ShopPreferences } from '@/lib/domain/shop-preferences';
import type {
  AgentModelMessage,
  AgentOrchestratorResponse,
  AgentToolCall,
  AgentToolName,
  AgentWorkflowState,
} from '@/lib/domain/agent-orchestrator';
import type {
  AgentConversationRecord,
  ConversationAssetSnapshot,
  ConversationAttachment,
  ConversationMessage,
  ConversationSummary,
} from '@/lib/domain/conversation';
import type { FactConflict, FactValue, ProductPassport } from '@/lib/domain/product-passport';
import type { GeneratedAsset } from '@/lib/domain/generated-asset';
import { sceneLabel, type ScenePlan } from '@/lib/domain/scene-plan';
import { PENDING_PRODUCT_NAME, type TaskSnapshot } from '@/lib/domain/task';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { hasCompleteListingLocalization } from '@/lib/agents/listing-localization';
import { marketLocale } from '@/lib/localization/market-locales';
import { platformRegistry } from '@/lib/platforms/registry';

type AgentPhase = 'loading' | 'idle' | 'intake' | 'resume' | 'processing' | 'conflict' | 'scene_plan' | 'listing' | 'image_brief' | 'assets' | 'video' | 'publish' | 'complete' | 'error';

interface ImageBrief { count: number | null; sceneCounts: Record<string, number> | null; style: string; notes: string }

type ChatMessage = ConversationMessage;

type DisplayAsset = Pick<GeneratedAsset, 'id' | 'kind' | 'title' | 'status' | 'width' | 'height' | 'error' | 'imageUrl'> & { sceneId?: string };

function displaySnapshots(assets: readonly ConversationAssetSnapshot[]): DisplayAsset[] {
  return assets.map((asset) => ({
    id: asset.id, kind: asset.kind, title: asset.title, status: 'COMPLETED',
    width: asset.width, height: asset.height, error: asset.error,
    imageUrl: `/api/tasks/${asset.taskId}/generated-assets/${asset.id}/file`,
  }));
}

const DEFAULT_RAIL_WIDTH = 272;
const MIN_RAIL_WIDTH = 220;
const MAX_RAIL_WIDTH = 420;
const RAIL_WIDTH_STORAGE_KEY = 'skuflow-agent-rail-width';
const COMPOSER_FILE_ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf,.xlsx,.xls,.csv,.txt,.docx';
const MAX_COMPOSER_FILES = 12;
const MAX_COMPOSER_TOTAL_SIZE = 40 * 1024 * 1024;

function StarterIcon({ kind }: { kind: 'new' | 'analyze' | 'rules' | 'optimize' }) {
  const shared = { viewBox: '0 0 32 32', fill: 'none', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  if (kind === 'new') return <svg {...shared}>
    <path d="M6.5 24.5l4.2-.8L24 10.4a2.4 2.4 0 0 0-3.4-3.4L7.3 20.3l-.8 4.2Z" stroke="#5d9685" />
    <path d="m18.7 8.9 3.4 3.4M7.2 20.6l3.2 3.2" stroke="#d5a252" />
    <path d="M22.5 20.5v6M19.5 23.5h6" stroke="#d88d70" />
  </svg>;
  if (kind === 'analyze') return <svg {...shared}>
    <circle cx="13.7" cy="13.7" r="8" stroke="#668da1" />
    <path d="m19.5 19.5 6.2 6.2" stroke="#668da1" />
    <path d="M10.2 16.5v-3.2M13.7 16.5V10M17.2 16.5v-5" stroke="#dba655" />
  </svg>;
  if (kind === 'rules') return <svg {...shared}>
    <rect x="5" y="5.5" width="22" height="21" rx="3.4" stroke="#d0a24e" />
    <path d="M5 11.5h22" stroke="#d0a24e" />
    <path d="M9.5 16.5h9M9.5 20.5h13" stroke="#6b9a94" />
    <circle cx="9" cy="8.5" r=".9" fill="#dc9275" stroke="none" />
    <circle cx="12.5" cy="8.5" r=".9" fill="#8b80ad" stroke="none" />
  </svg>;
  return <svg {...shared}>
    <path d="M6 8.5h20M6 16h20M6 23.5h20" stroke="#8b7db2" />
    <circle cx="12" cy="8.5" r="2.5" fill="#fff" stroke="#d99d76" />
    <circle cx="20" cy="16" r="2.5" fill="#fff" stroke="#6ba798" />
    <circle cx="14" cy="23.5" r="2.5" fill="#fff" stroke="#d0aa58" />
  </svg>;
}

interface ToolRun {
  id: string;
  name: AgentToolName;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
}

interface FailedAgentTurn {
  task: TaskSnapshot | null;
  userText: string;
  history: AgentModelMessage[];
  pendingFiles: File[];
  publishApproved: boolean;
  allowConversation: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function RichMessageContent({ message }: { message: ChatMessage }) {
  const imageBrief = message.role === 'user' && message.meta === '图片需求已确认'
    ? message.text.match(/数量：(.+?)；风格：(.+?)；其他要求：(.+?)。只生成图片/)
    : null;
  const displayText = imageBrief
    ? ['生成图片', imageBrief[1] === '由 Agent 决定' ? '' : imageBrief[1], imageBrief[2] === '由 Agent 决定' ? '' : imageBrief[2], imageBrief[3] === '无' ? '' : imageBrief[3]].filter(Boolean).join(' · ')
    : message.text;
  return <>
    {displayText && <p>{displayText}</p>}
    {message.attachments && message.attachments.length > 0 && <div className="rich-file-list">
      {message.attachments.map((file) => {
        if(file.fileId.startsWith('video_')&&file.contentType.startsWith('video/')) return <div className="chat-result-video" key={file.fileId}><video controls playsInline preload="metadata" src={`/api/tasks/${file.taskId}/videos/${file.fileId}/file`}/><a href={`/api/tasks/${file.taskId}/videos/${file.fileId}/file`} download>下载结果视频</a></div>;
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
    {message.meta && message.meta !== '图片需求已确认' && !(message.kind === 'video' && message.videoJobIds?.length) && <small>{message.meta}</small>}
  </>;
}

function currentListingMessage(message: ChatMessage, passport: ProductPassport | null): ChatMessage {
  if (message.kind !== 'listing' || !passport?.platformDrafts.length || !message.items?.length) return message;
  const drafts = new Map(passport.platformDrafts.map((draft) => [draft.id, draft]));
  const items = message.items.map((item) => {
    const draft = drafts.get(item.id);
    if (!draft) return item;
    return { ...item, status: draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED' ? '已确认' : '待审核' };
  });
  const allApproved = passport.platformDrafts.every((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
  return {
    ...message,
    items,
    ...(allApproved ? {
      text: `${passport.platformDrafts.length} 份平台中文审校稿已确认。接下来一起检查图片和视频素材。`,
      meta: 'Listing 已确认',
    } : {}),
  };
}

function mediaCheckpoint(messages: ChatMessage[]): string | undefined {
  return messages.findLast((message) => ['等待素材选择', '图片已确认', '视频生成中', '等待视频确认', '视频阶段已完成', '素材选择已记录', '目标已更新'].includes(message.meta ?? ''))?.meta;
}

function imagesConfirmedFromMessages(messages: ChatMessage[]): boolean {
  const checkpoint = mediaCheckpoint(messages);
  return Boolean(checkpoint && checkpoint !== '等待素材选择' && checkpoint !== '目标已更新');
}

function videoStageCompleteFromMessages(messages: ChatMessage[]): boolean {
  return ['视频阶段已完成', '素材选择已记录'].includes(mediaCheckpoint(messages) ?? '');
}

function imageBriefConfirmedFromMessages(messages: ChatMessage[]): boolean {
  const latestQuestion = messages.findLastIndex((message) => message.meta === '等待图片需求' || message.meta === '目标已更新');
  const latestAnswer = messages.findLastIndex((message) => message.meta === '图片需求已确认');
  return latestAnswer >= 0 && latestAnswer > latestQuestion;
}

const initialMessages: ChatMessage[] = [{
  id: 'welcome',
  role: 'agent',
  text: '你好，我是你的上新助手。今天想上新什么商品？',
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
    POSTER: '海报图',
    CUSTOM: '创意图片',
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

function AssetConversationCard({ assets, selected, onToggle, onConfirm, onSkipVideo, onAdjustCounts, scenePlan = null, splitMode = false, readOnly = false }: {
  assets: DisplayAsset[];
  selected: string[];
  onToggle: (id: string) => void;
  onConfirm: () => void;
  onSkipVideo: () => void;
  onAdjustCounts?: () => void;
  scenePlan?: ScenePlan | null;
  splitMode?: boolean;
  readOnly?: boolean;
}) {
  const rejectedCount = assets.filter((asset) => asset.kind !== 'VIDEO' && asset.status === 'COMPLETED' && asset.imageUrl && asset.error).length;
  const failed = assets.filter((asset) => asset.kind !== 'VIDEO' && asset.status === 'FAILED');
  const completed = assets.filter((asset) => asset.kind !== 'VIDEO' && asset.status === 'COMPLETED' && asset.imageUrl && (readOnly || !asset.error));
  const selectedCount = completed.filter((asset) => selected.includes(asset.id)).length;
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const previewButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closePreview = () => {
    const previousIndex = previewIndex;
    setPreviewIndex(null);
    setZoomed(false);
    if (previousIndex !== null) window.requestAnimationFrame(() => previewButtons.current[previousIndex]?.focus());
  };
  const movePreview = (direction: number) => {
    setPreviewIndex((current) => current === null ? null : (current + direction + completed.length) % completed.length);
    setZoomed(false);
  };
  useEffect(() => {
    if (previewIndex === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closePreview(); }
      if (event.key === 'ArrowLeft' && completed.length > 1) { event.preventDefault(); movePreview(-1); }
      if (event.key === 'ArrowRight' && completed.length > 1) { event.preventDefault(); movePreview(1); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', handleKeyDown); };
  // The keyboard handler is renewed when the displayed image changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewIndex, completed.length]);
  const previewAsset = previewIndex === null ? null : completed[previewIndex] ?? null;
  const renderTile = (asset: DisplayAsset) => {
    const index = completed.findIndex((item) => item.id === asset.id);
    return <div className={`image-picker-tile ${selected.includes(asset.id) ? 'selected' : ''}`} key={asset.id}>
      <button type="button" className="image-picker-preview-trigger" ref={(element) => { previewButtons.current[index] = element; }} aria-label={`预览图片 ${index + 1}：${asset.title}`} onClick={() => { setPreviewIndex(index); setZoomed(false); }}>
        <span className="agent-asset-preview"><Image src={asset.imageUrl!} alt={asset.title} width={asset.width ?? 512} height={asset.height ?? 512} unoptimized /></span>
      </button>
      {!readOnly && <button type="button" className="image-picker-select-toggle" aria-label={`${selected.includes(asset.id) ? '取消选择' : '选择'}图片 ${index + 1}`} aria-pressed={selected.includes(asset.id)} onClick={() => onToggle(asset.id)}>{selected.includes(asset.id) ? '✓' : '+'}</button>}
      {asset.error && <span className="image-picker-review-badge">未通过验收</span>}
    </div>;
  };
  return <div className="asset-conversation-card image-picker-card">
    <h3 className="visually-hidden">选择商品图片</h3>
    {scenePlan?.mode === 'SPLIT' && !readOnly ? scenePlan.scenes.map((scene) => { const sceneAssets = completed.filter((asset) => asset.sceneId === scene.id); return <section className="scene-image-pick-group" key={scene.id}><header><b>{scene.name}</b><span>已选 {sceneAssets.filter((asset) => selected.includes(asset.id)).length}/{sceneAssets.length} 张</span></header><div className="agent-asset-grid">{sceneAssets.map(renderTile)}</div>{sceneAssets.length === 0 && <small>这套场景暂无通过验收的图片，可在对话中要求重试。</small>}</section>; }) : <div className="agent-asset-grid">{completed.map(renderTile)}</div>}
    {!readOnly && (failed.length > 0 || rejectedCount > 0) && <details className="image-picker-failure-details"><summary>{failed.length + rejectedCount} 张图片未加入可选结果</summary>{failed.map((asset) => <p key={asset.id}>{asset.title}：{asset.error || '生成失败'}</p>)}{rejectedCount > 0 && <p>{rejectedCount} 张旧图未通过验收。</p>}</details>}
    {!readOnly && <footer><span>已选 {selectedCount}/{completed.length} 张</span>{splitMode && onAdjustCounts && <button type="button" onClick={onAdjustCounts}>调整各场景张数</button>}<button type="button" disabled={selectedCount === 0} onClick={onSkipVideo}>只用图片继续</button><button className="primary" type="button" disabled={selectedCount === 0} onClick={onConfirm}>{splitMode?'确认各场景图片，设置视频':'确认图片，设置视频'}</button></footer>}
    {previewAsset && typeof document !== 'undefined' && createPortal(<div className="asset-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}>
      <section className="asset-preview-dialog" role="dialog" aria-modal="true" aria-label={`预览图片 ${previewIndex! + 1}：${previewAsset.title}`}>
        <header><span>{previewIndex! + 1} / {completed.length}</span><button type="button" ref={closeButton} aria-label="关闭图片预览" onClick={closePreview}>×</button></header>
        <div className="asset-preview-stage">
          {completed.length > 1 && <button className="asset-preview-nav previous" type="button" aria-label="上一张图片" onClick={() => movePreview(-1)}>‹</button>}
          <div className={`asset-preview-viewport ${zoomed ? 'zoomed' : ''}`}><Image src={previewAsset.imageUrl!} alt={previewAsset.title} width={previewAsset.width ?? 1024} height={previewAsset.height ?? 1024} unoptimized onClick={() => setZoomed((value) => !value)} /></div>
          {completed.length > 1 && <button className="asset-preview-nav next" type="button" aria-label="下一张图片" onClick={() => movePreview(1)}>›</button>}
        </div>
        {previewAsset.error && <p className="image-picker-review-detail">{previewAsset.error}</p>}
        <footer><button type="button" onClick={() => setZoomed((value) => !value)}>{zoomed ? '适应窗口' : '放大看细节'}</button>{!readOnly && <button type="button" className="primary" aria-pressed={selected.includes(previewAsset.id)} onClick={() => onToggle(previewAsset.id)}>{selected.includes(previewAsset.id) ? '✓ 已选择，点击取消' : '选择这张图片'}</button>}</footer>
      </section>
    </div>, document.body)}
  </div>;
}

function localizationPreviewValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(localizationPreviewValue).join(' · ');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}：${localizationPreviewValue(item)}`).join('；');
  return typeof value === 'string' ? value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : String(value ?? '');
}

function PublishDialog({ task, passport, scenePlan, selectedAssets, busy, localizationBusy, localizationError, onRetryLocalization, onPublish, onClose }: {
  task: TaskSnapshot;
  passport: ProductPassport;
  scenePlan: ScenePlan | null;
  selectedAssets: string[];
  busy: boolean;
  localizationBusy: boolean;
  localizationError: string;
  onRetryLocalization: () => void;
  onPublish: () => void;
  onClose: () => void;
}) {
  const approved = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED');
  const platformNames = [...new Set(approved.map((draft) => draft.platformId))]
    .map((id) => platformRegistry.find((item) => item.id === id)?.shortName ?? id);
  const shopifyCount = approved.filter((draft) => draft.platformId === 'shopify').length;
  const amazonCount = approved.filter((draft) => draft.platformId === 'amazon').length;
  const mockCount = approved.length - shopifyCount - amazonCount;
  const deliveryMode = [shopifyCount ? 'Shopify Dev Store 测试草稿' : '', amazonCount ? 'Amazon 所选站点官方静态沙箱测试' : '', mockCount ? '其他平台本地 Mock' : ''].filter(Boolean).join(' + ');
  const localizationReady = approved.length > 0 && approved.every((draft) => isListingDraftPayload(draft.payload) && hasCompleteListingLocalization(draft.payload, marketLocale(draft.market).locale));
  return <AgentDialog eyebrow="FINAL CHECKPOINT · DELIVERY" title="确认发布这个商品？" onClose={onClose} wide>
    <div className="publish-confirm-product"><span>↗</span><div><b>{task.productName}</b><small>{scenePlan?.mode === 'SPLIT' ? `${scenePlan.scenes.length} 套场景 · ` : ''}${approved.length} 份 Listing · {selectedAssets.length} 项已选素材</small></div></div>
    <dl className="publish-confirm-list"><div><dt>目标平台</dt><dd>{platformNames.join('、')}</dd></div><div><dt>目标市场</dt><dd>{[...new Set(approved.map((draft) => draft.market))].join('、')}</dd></div><div><dt>审核版本</dt><dd>简体中文审校稿（已锁定）</dd></div><div><dt>发布语言</dt><dd>{localizationBusy ? '正在准备各站点的语言版本…' : localizationReady ? approved.map((draft) => isListingDraftPayload(draft.payload) ? `${draft.market}：${draft.payload.localization?.targetLanguage}（${draft.payload.localization?.targetLocale}）` : draft.market).join('；') : '等待生成'}</dd></div><div><dt>发布模式</dt><dd>{deliveryMode || '测试草稿'}</dd></div></dl>
    <section className="publish-localizations"><header><span>站点本地化预览</span><b>以下译文用于测试交付</b></header>
      {localizationBusy && <div className="publish-localization-loading"><span className="agent-spinner"/><p>正在准备各站点的商品文案。完成后请先检查译文，再决定是否继续。</p></div>}
      {localizationError && <div className="publish-localization-error" role="alert"><p>{localizationError}</p><button type="button" onClick={onRetryLocalization}>重新生成译文</button></div>}
      {!localizationBusy && !localizationError && approved.map((draft) => {
        if (!isListingDraftPayload(draft.payload)) return null;
        const payload = draft.payload;
        const localization = payload.localization;
        if (!localization) return null;
        const entries = payload.schema.fields.flatMap((field) => {
          if (!Object.prototype.hasOwnProperty.call(payload.fields, field.key)) return [];
          const value = Object.prototype.hasOwnProperty.call(localization.fields, field.key)
            ? localization.fields[field.key] : payload.fields[field.key];
          return [[field.key, field.label, value] as const];
        });
        return <article key={draft.id}><div><b>{platformRegistry.find((item) => item.id === draft.platformId)?.shortName ?? draft.platformId} · {draft.market}{scenePlan?.mode === 'SPLIT' ? ` · ${sceneLabel(draft.sceneId, scenePlan)}` : ''}</b><span>{localization.targetLanguage} · {localization.targetLocale}</span></div><dl>{entries.map(([key, label, value]) => <div key={key}><dt>{label}</dt><dd>{localizationPreviewValue(value)}</dd></div>)}</dl><small>文案及描述性属性已本地化；SKU、价格、库存及品牌专名等经营字段保持原值。</small></article>;
      })}
    </section>
    <div className="publish-warning"><b>安全测试模式</b><span>{shopifyCount ? 'Shopify 将调用官方 Dev Store 接口，只创建 DRAFT 商品，不会公开上架；' : ''}{amazonCount ? 'Amazon 会按所选站点调用对应区域的官方静态沙箱；预设响应不代表真实上架，媒体编排只保存在 SKUFlow；' : ''}{mockCount ? '其他平台仍只创建本地 Mock 草稿；' : ''}若连接未配置，Agent 会暂停并提示所需信息。</span></div>
    <div className="dialog-footer"><button className="ghost" type="button" onClick={onClose}>再检查一下</button><button className="primary" type="button" disabled={busy || localizationBusy || !localizationReady || Boolean(localizationError)} onClick={onPublish}>{busy ? '测试交付中…' : localizationBusy ? '正在准备译文…' : `确认译文并测试 ${approved.length} 份 Listing`}</button></div>
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

export function AgentConversation({ account, initialWorkspace = 'agent' }: { account: AccountIdentity; initialWorkspace?: 'agent' | 'batch' }) {
  const avatar = Array.from(account.name)[0]?.toUpperCase() || "用";
  const [workspace, setWorkspace] = useState<'agent' | 'batch'>(initialWorkspace);
  const [batchOpened, setBatchOpened] = useState(initialWorkspace === 'batch');
  const [phase, setPhase] = useState<AgentPhase>('loading');
  const [progressStep, setProgressStep] = useState(0);
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [passport, setPassport] = useState<ProductPassport | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [busyLabel, setBusyLabel] = useState('正在打开你的工作区…');
  const [busyHint, setBusyHint] = useState('');
  const [error, setError] = useState('');
  const [canRetryFailedTurn, setCanRetryFailedTurn] = useState(false);
  const [composer, setComposer] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [localizationBusy, setLocalizationBusy] = useState(false);
  const [localizationError, setLocalizationError] = useState('');
  const [localizationRevision, setLocalizationRevision] = useState(0);
  const [manualConflictValue, setManualConflictValue] = useState('');
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [mediaGuidance,setMediaGuidance] = useState('');
  const mediaPlanRef = useRef<string | null>(null);
  const [mediaPlanReady,setMediaPlanReady] = useState(false);
  const [videoRevision,setVideoRevision] = useState(0);
  const [generatedAssets, setGeneratedAssets] = useState<GeneratedAsset[]>([]);
  const [scenePlan, setScenePlan] = useState<ScenePlan | null>(null);
  const [sceneMode, setSceneMode] = useState<'SINGLE' | 'SPLIT'>('SINGLE');
  const [sceneCount, setSceneCount] = useState(2);
  const [sceneDirections, setSceneDirections] = useState<string[]>(Array(6).fill(''));
  const [imageBriefCount, setImageBriefCount] = useState<number | null>(null);
  const [sceneImageCounts, setSceneImageCounts] = useState<Record<string, number>>({});
  const [imageBriefStyle, setImageBriefStyle] = useState('');
  const [imageBriefNotes, setImageBriefNotes] = useState('');
  const imageBriefRef = useRef<ImageBrief | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<ConversationSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [itemMenu, setItemMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pauseRequested, setPauseRequested] = useState(false);
  const pauseRequestedRef = useRef(false);
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [targetEditorOpen, setTargetEditorOpen] = useState(false);
  const [preferences, setPreferences] = useState<ShopPreferences | null>(null);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const targetReturnPhase = useRef<AgentPhase>('resume');
  const threadEnd = useRef<HTMLDivElement>(null);
  const composerFileInput = useRef<HTMLInputElement>(null);
  const modelHistory = useRef<AgentModelMessage[]>([]);
  const failedTurnRef = useRef<FailedAgentTurn | null>(null);
  const messagesRef = useRef<ChatMessage[]>(initialMessages);
  const toolRunsRef = useRef<ToolRun[]>([]);
  const selectedAssetsRef = useRef<string[]>([]);
  const conversationIdRef = useRef<string | null>(null);
  const railWidthRef = useRef(DEFAULT_RAIL_WIDTH);
  const railResizeStart = useRef<{ x: number; width: number } | null>(null);

  const platformNames = useMemo(() => new Map(platformRegistry.map((item) => [item.id, item.shortName])), []);
  const currentStep = phase === 'conflict' ? 1 : phase === 'scene_plan' || phase === 'listing' ? 2 : phase === 'image_brief' || phase === 'assets' || phase === 'video' ? 3 : phase === 'publish' || phase === 'complete' ? 4 : phase === 'processing' ? progressStep : 0;

  useEffect(() => {
    let active = true;
    void fetch('/api/shop-preferences').then(async (response) => {
      if (!response.ok) return null;
      const data = await response.json() as { preferences: ShopPreferences | null };
      return data.preferences;
    }).then((value) => { if (active) setPreferences(value); }).catch(() => {}).finally(() => { if (active) setPreferencesLoaded(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const syncWorkspace = () => {
      const next = window.location.pathname === '/batches' ? 'batch' : 'agent';
      setWorkspace(next);
      if (next === 'batch') setBatchOpened(true);
    };
    window.addEventListener('popstate', syncWorkspace);
    return () => window.removeEventListener('popstate', syncWorkspace);
  }, []);

  const showWorkspace = (next: 'agent' | 'batch') => {
    setWorkspace(next);
    if (next === 'batch') setBatchOpened(true);
    setContextOpen(false);
    setPublishOpen(false);
    setItemMenu(null);
    const destination = next === 'batch' ? '/batches' : '/';
    if (window.location.pathname !== destination) window.history.pushState({}, '', `${destination}${window.location.search}`);
  };

  useEffect(() => {
    if (!publishOpen || !task || !passport) return;
    const approved = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED');
    if (!approved.length || approved.every((draft) => isListingDraftPayload(draft.payload) && hasCompleteListingLocalization(draft.payload, marketLocale(draft.market).locale))) {
      queueMicrotask(() => { setLocalizationError(''); setLocalizationBusy(false); });
      return;
    }
    let active = true;
    queueMicrotask(() => { if (active) { setLocalizationBusy(true); setLocalizationError(''); } });
    void (async () => {
      try {
        const payload = await responseJson<{ passport: ProductPassport }>(await fetch(`/api/tasks/${task.id}/localize-drafts`, { method: 'POST' }), '目标站点译文生成失败');
        if (active) setPassport(payload.passport);
      } catch (caught) {
        if (active) setLocalizationError(caught instanceof Error ? caught.message : '目标站点译文生成失败');
      } finally {
        if (active) setLocalizationBusy(false);
      }
    })();
    return () => { active = false; };
  }, [publishOpen, task, passport, localizationRevision]);

  const append = (
    role: ChatMessage['role'],
    text: string,
    meta?: string,
    rich: Partial<Pick<ChatMessage, 'kind' | 'attachments' | 'items' | 'assets' | 'videoJobIds'>> = {},
  ) => {
    const next = [...messagesRef.current, { id: messageId(), role, text, ...(meta ? { meta } : {}), ...rich }].slice(-200);
    messagesRef.current = next;
    setMessages(next);
  };

  const recordVideoJob = (jobId: string) => {
    const current = messagesRef.current;
    const last = current.at(-1);
    if (last?.role === 'agent' && last.meta === '等待视频确认' && !last.videoJobIds?.length) {
      const next = [...current.slice(0, -1), { ...last, kind: 'video' as const, videoJobIds: [jobId] }];
      messagesRef.current = next;
      setMessages(next);
    } else {
      append('agent', '', '等待视频确认', { kind: 'video', videoJobIds: [jobId] });
    }
    void persistConversation(task?.id ?? null).catch((caught) => setError(caught instanceof Error ? caught.message : '视频轮次保存失败'));
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
    const imageScenes = new Map(payload.assets.map((asset) => [asset.id, asset.sceneId]));
    return [...payload.assets,...videos.jobs.filter(j=>j.status==='SUCCEEDED').map(j=>({id:j.id,taskId,sourceFileId:j.plan.sourceFileId,batchId:'video',sceneId:imageScenes.get(j.plan.sourceFileId)??'base',kind:'VIDEO' as const,title:j.plan.title,note:j.plan.shots.join('；'),model:'wan2.7-i2v',status:'COMPLETED' as const,width:null,height:null,error:null,createdAt:'',completedAt:null,imageUrl:j.videoUrl}))];
  };

  const fetchGeneratedAssetHistory = async (taskId: string): Promise<GeneratedAsset[][]> => {
    const payload = await responseJson<{ batches: GeneratedAsset[][] }>(
      await fetch(`/api/tasks/${taskId}/generated-assets?history=1`), '历史图片读取失败',
    );
    return payload.batches;
  };

  const updateConversationList = (conversation: AgentConversationRecord | ConversationSummary) => {
    setConversations((current) => current.some((item) => item.id === conversation.id)
      ? current.map((item) => item.id === conversation.id ? conversation : item)
      : [conversation, ...current]);
  };

  const applyConversation = async (conversation: AgentConversationRecord) => {
    setContextOpen(false);
    setTargetEditorOpen(false);
    failedTurnRef.current = null;
    setCanRetryFailedTurn(false);
    conversationIdRef.current = conversation.id;
    setConversationId(conversation.id);
    const storedMessages = conversation.messages.length ? conversation.messages : initialMessages;
    messagesRef.current = storedMessages.filter((message) => message.kind !== 'tool');
    const removedInternalLogs = messagesRef.current.length !== storedMessages.length;
    setMessages(messagesRef.current);
    modelHistory.current = conversation.modelHistory;
    toolRunsRef.current = conversation.toolRuns;
    mediaPlanRef.current=null;setMediaPlanReady(false);setMediaGuidance('');
    imageBriefRef.current = null;
    setImageBriefCount(null); setSceneImageCounts({}); setImageBriefStyle(''); setImageBriefNotes('');
    selectedAssetsRef.current = conversation.selectedAssetIds;
    setSelectedAssets(conversation.selectedAssetIds);
    setPendingFiles([]);
    if (composerFileInput.current) composerFileInput.current.value = '';
    setError(''); setComposer('');
    setPublishOpen(false);
    updateConversationList(conversation);
    if (!conversation.taskId) {
      const intakeStarted = conversation.toolRuns.some((run) => run.name === 'start_listing_workflow' && run.status === 'COMPLETED');
      setTask(null); setPassport(null); setGeneratedAssets([]); setScenePlan(null); setPhase(intakeStarted ? 'intake' : 'idle'); setProgressStep(0);
      if (removedInternalLogs) await persistConversation(null, conversation.status);
      return;
    }
    const needsAssetHistory = messagesRef.current.some((message) => message.kind === 'assets' && !message.assets?.length);
    const [loadedTask, loadedPassport, loadedAssets, loadedScenePlan, assetHistory, videoHistory] = await Promise.all([
      fetchTask(conversation.taskId), fetchPassport(conversation.taskId), fetchGeneratedAssets(conversation.taskId),
      fetch(`/api/tasks/${conversation.taskId}/scene-plan`).then((response) => responseJson<{ plan: ScenePlan | null }>(response, '场景方案读取失败')).then((data) => data.plan),
      needsAssetHistory ? fetchGeneratedAssetHistory(conversation.taskId).catch(() => []) : Promise.resolve([]),
      fetch(`/api/tasks/${conversation.taskId}/videos`)
        .then((response) => responseJson<{ jobs: Array<{ id: string; status: string }> }>(response, '历史视频读取失败'))
        .catch(() => ({ jobs: [] })),
    ]);
    setTask(loadedTask); setPassport(loadedPassport); setGeneratedAssets(loadedAssets); setScenePlan(loadedScenePlan);
    let conversationUpgraded = removedInternalLogs;
    if (needsAssetHistory && assetHistory.length) {
      const recovered = restoreConversationAssetSnapshots(messagesRef.current, assetHistory);
      if (recovered.changed) {
        messagesRef.current = recovered.messages;
        setMessages(recovered.messages);
        conversationUpgraded = true;
      }
    }
    const restoredVideos = restoreConversationVideoRounds(messagesRef.current, videoHistory.jobs);
    if (restoredVideos.changed) {
      messagesRef.current = restoredVideos.messages;
      setMessages(restoredVideos.messages);
      conversationUpgraded = true;
    }
    const validAssetIds = new Set(loadedAssets.filter((asset) => asset.status === 'COMPLETED' && (asset.kind === 'VIDEO' || !asset.error)).map((asset) => asset.id));
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
    const generated = loadedPassport.platformDrafts.length > 0 && loadedPassport.platformDrafts.every((draft) => isListingDraftPayload(draft.payload));
    const allApproved = loadedPassport.platformDrafts.length > 0 && loadedPassport.platformDrafts.every((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
    const imageSelected = validSelections.some((id) => loadedAssets.some((asset) => asset.id === id && asset.kind !== 'VIDEO'));
    const imagesConfirmed = imagesConfirmedFromMessages(messagesRef.current);
    const videoDone = videoStageCompleteFromMessages(messagesRef.current);
    setPhase(published ? 'complete' : openConflicts ? 'conflict' : allApproved ? (imageSelected && imagesConfirmed ? videoDone ? 'publish' : 'video' : loadedAssets.some((asset) => asset.kind !== 'VIDEO') ? 'assets' : 'image_brief') : generated ? 'listing' : !loadedScenePlan && loadedPassport.facts.length > 0 ? 'scene_plan' : 'resume');
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
        modelHistory: compactAgentModelHistory(modelHistory.current),
        toolRuns: toolRunsRef.current,
        selectedAssetIds: selectedAssetsRef.current,
      }),
    }), '会话保存失败');
    updateConversationList(payload.conversation);
  };

  const loadConversation = async (id: string) => {
    if (id === conversationIdRef.current) return;
    await persistConversation();
    setPhase('loading'); setBusyLabel('正在打开这件商品的进度…'); setBusyHint('稍后就可以接着上次的步骤继续');
    const payload = await responseJson<{ conversation: AgentConversationRecord }>(await fetch(`/api/conversations/${id}`), '会话读取失败');
    await applyConversation(payload.conversation);
  };

  const openConversation = async (id: string) => {
    try {
      await loadConversation(id);
      const url = new URL(window.location.href);
      url.searchParams.set('conversation', id);
      window.history.replaceState({}, '', `${url.pathname}${url.search}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '商品任务加载失败');
    }
  };

  const createConversation = async (taskId?: string) => {
    const payload = await responseJson<{ conversation: AgentConversationRecord }>(await fetch('/api/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(taskId ? { taskId } : {}),
    }), '新建会话失败');
    await applyConversation(payload.conversation);
    const url = new URL(window.location.href);
    url.searchParams.set('conversation', payload.conversation.id);
    window.history.replaceState({}, '', `${url.pathname}${url.search}`);
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
          const requestedId = new URLSearchParams(window.location.search).get('conversation');
          const initial = requestedId && /^conversation_[a-zA-Z0-9-]+$/.test(requestedId) ? requestedId : listed.conversations[0].id;
          const payload = await responseJson<{ conversation: AgentConversationRecord }>(await fetch(`/api/conversations/${initial}`), '会话读取失败');
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

  const composerDropHandlers = {
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      if (task === null && phase !== 'processing') setDragActive(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      event.preventDefault();
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      if (task !== null || phase === 'processing') return;
      if (event.dataTransfer.files?.length) addComposerFiles(event.dataTransfer.files);
    },
  };

  const refreshTaskState = async (taskId: string) => {
    const [nextTask, nextPassport] = await Promise.all([fetchTask(taskId), fetchPassport(taskId)]);
    setTask(nextTask);
    setPassport(nextPassport);
    return { task: nextTask, passport: nextPassport };
  };

  const phaseFromState = (state: AgentWorkflowState) => {
    if (!state.taskId) return setPhase(state.intakePresented ? 'intake' : 'idle');
    if (state.draftCount > 0 && state.publishedDraftCount === state.draftCount) return setPhase('complete');
    if (state.openConflictCount > 0) return setPhase('conflict');
    if (state.factCount > 0 && !state.scenePlanConfirmed && state.generatedDraftCount === 0) return setPhase('scene_plan');
    if (state.draftCount > 0 && state.generatedDraftCount === state.draftCount && state.approvedDraftCount < state.draftCount) return setPhase('listing');
    if (state.draftCount > 0 && state.approvedDraftCount >= state.draftCount) {
      return setPhase((state.selectedImageCount ?? state.selectedAssetCount) > 0 && state.imagesConfirmed ? state.videoStageComplete ? 'publish' : 'video' : state.generatedAssetCount > 0 ? 'assets' : 'image_brief');
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
      if (name === 'open_target_selection') {
        if (!currentTask) throw new Error('当前还没有创建商品任务');
        targetReturnPhase.current = 'resume';
        setTargetEditorOpen(true);
        setError(''); setCanRetryFailedTurn(false); failedTurnRef.current = null;
        setPhase('resume');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, awaitingSelection: true }, checkpoint: true };
      }
      if (name === 'inspect_chat_attachments') {
        if (attachmentFiles.length === 0) throw new Error('本轮没有可读取的聊天附件');
        setBusyLabel('正在查看你上传的资料…'); setBusyHint('看完后会整理出与你的问题有关的信息');
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
        setBusyLabel('正在创建这件商品的上新任务…'); setBusyHint('完成后可以从左侧对话继续查看');
        const body = new FormData();
        const targets = inferConversationTargets(modelHistory.current);
        let targetError = '';
        try { targetsFromSharedSelection(targets.platforms, targets.markets); }
        catch (error) { targetError = error instanceof Error ? error.message : '请分别指定平台和站点'; }
        if (targetError) {
          setPhase('intake');
          append('agent', `${targetError}。已收到的 ${attachmentFiles.length} 份资料会保留，请在下方为每个平台选择站点。`, '补充目标站点');
          markToolRun(call, 'COMPLETED');
          return { result: { ok: true, presented: true }, checkpoint: true };
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
        let canCreateDirectly = false;
        if (targets.platforms.length && targets.markets.length) {
          try { targetsFromSharedSelection(targets.platforms, targets.markets); canCreateDirectly = true; } catch { /* use the platform-specific selection card */ }
        }
        if (attachmentFiles.length && canCreateDirectly) {
          markToolRun(call, 'COMPLETED');
          return executeTool({ ...call, function: { name: 'create_listing_task_from_attachments', arguments: '{}' } }, currentTask, publishApproved, attachmentFiles, requestText);
        }
        setPhase('intake');
        const missing = [!targets.platforms.length ? '目标平台' : '', !targets.markets.length ? '目标市场' : '', !attachmentFiles.length ? '商品资料' : ''].filter(Boolean);
        append('agent', `${attachmentFiles.length ? `已收到 ${attachmentFiles.length} 份商品资料，无需重复上传。` : ''}还需要确认${missing.length ? missing.join('、') : '各平台对应的目标站点'}。你可以直接在对话里告诉我，也可以使用下方选择卡。`, '仅补充缺失信息');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true }, checkpoint: true };
      }
      if (!currentTask) throw new Error('当前还没有创建商品任务');
      if (name === 'parse_product_sources') {
        setProgressStep(0); setBusyLabel('正在整理商品资料…'); setBusyHint('会从图片、表格和文档中找出商品信息');
        const payload = await responseJson<{ summary: Record<string, unknown> }>(await fetch(`/api/tasks/${currentTask.id}/parse`, { method: 'POST' }), '资料解析失败');
        await refreshTaskState(currentTask.id);
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary }, checkpoint: false };
      }
      if (name === 'analyze_product_images') {
        setProgressStep(1); setBusyLabel('正在查看商品图片…'); setBusyHint('会辨认图片中看得清的款式、颜色和细节');
        const payload = await responseJson<{ summary: { completed: number; failed: number } }>(await fetch(`/api/tasks/${currentTask.id}/analyze-images`, { method: 'POST' }), '图片理解失败');
        if (payload.summary.completed === 0) throw new Error(`图片理解未得到有效结果（失败 ${payload.summary.failed} 张）`);
        await refreshTaskState(currentTask.id);
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary }, checkpoint: false };
      }
      if (name === 'merge_product_facts') {
        setProgressStep(1); setBusyLabel('正在核对商品信息…'); setBusyHint('如果图片和资料说法不同，会请你确认');
        const payload = await responseJson<{ summary: Record<string, unknown>; passport: ProductPassport; task: TaskSnapshot }>(await fetch(`/api/tasks/${currentTask.id}/extract-facts`, { method: 'POST' }), '商品事实合并失败');
        setPassport(payload.passport); setTask(payload.task);
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary }, checkpoint: false };
      }
      if (name === 'open_scene_plan') {
        setPhase('scene_plan');
        append('agent', '商品信息已整理好。你想按一套方案上新，还是为同一件商品做几套不同场景的图片和文案？', '等待选择场景方案');
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, awaitingSelection: true }, checkpoint: true };
      }
      if (name === 'update_task_targets') {
        if (!currentTask) throw new Error('当前还没有创建商品任务');
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('目标参数无效'); }
        const platforms = Array.isArray(args.platforms) ? args.platforms.filter((item): item is string => typeof item === 'string') : [];
        const markets = Array.isArray(args.markets) ? args.markets.filter((item): item is string => typeof item === 'string') : [];
        setBusyLabel('正在调整发布目标…'); setBusyHint('稍后会按新选择的站点重新准备商品文案');
        const payload = await responseJson<{ task: TaskSnapshot }>(await fetch(`/api/tasks/${currentTask.id}/targets`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platforms, markets }),
        }), '目标平台与站点更新失败');
        setTask(payload.task);
        setPassport(await fetchPassport(currentTask.id));
        mediaPlanRef.current = null; setMediaPlanReady(false);
        markToolRun(call, 'COMPLETED');
        return {
          result: { ok: true, platforms: payload.task.platforms, markets: payload.task.markets, note: '目标已更新，旧的 Listing 审校稿已作废；图文冲突与商品事实保留。' },
          checkpoint: false, task: payload.task,
        };
      }
      if (name === 'reparse_sources') {
        if (!currentTask) throw new Error('当前还没有创建商品任务');
        setBusyLabel('正在重新整理商品资料…'); setBusyHint('整理完成后会更新商品信息和待确认内容');
        const payload = await responseJson<{ summary: Record<string, unknown> }>(await fetch(`/api/tasks/${currentTask.id}/parse`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }),
        }), '资料重新解析失败');
        await refreshTaskState(currentTask.id);
        setPassport(await fetchPassport(currentTask.id));
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary, note: '资料已重新解析，旧审校稿已作废。请继续重新理解图片（如有）并重新合并事实，再回到冲突确认或 Listing 生成。' }, checkpoint: false };
      }
      if (name === 'reanalyze_images') {
        if (!currentTask) throw new Error('当前还没有创建商品任务');
        setProgressStep(1); setBusyLabel('正在重新查看商品图片…'); setBusyHint('看完后会更新从图片中辨认出的信息');
        const payload = await responseJson<{ summary: { completed: number; failed: number } }>(await fetch(`/api/tasks/${currentTask.id}/analyze-images`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }),
        }), '图片重新理解失败');
        if (payload.summary.completed === 0) throw new Error(`图片重新理解未得到有效结果（失败 ${payload.summary.failed} 张）`);
        await refreshTaskState(currentTask.id);
        setPassport(await fetchPassport(currentTask.id));
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary, note: '图片已重新理解，旧审校稿已作废。请继续调用 merge_product_facts 重新合并事实。' }, checkpoint: false };
      }
      if (name === 'reopen_resolved_conflicts') {
        if (!currentTask) throw new Error('当前还没有创建商品任务');
        setBusyLabel('正在准备重新确认有分歧的信息…'); setBusyHint('之前的选择会重新开放，方便你修改');
        const payload = await responseJson<{ reopened: number; note: string }>(await fetch(`/api/tasks/${currentTask.id}/conflicts/reopen`, {
          method: 'PUT',
        }), '冲突重置失败');
        setPassport(await fetchPassport(currentTask.id));
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, reopened: payload.reopened, note: payload.note }, checkpoint: false };
      }
      if (name === 'generate_platform_listings') {
        const latestPassport = await fetchPassport(currentTask.id);
        const remaining = latestPassport.platformDrafts.filter((draft) => draft.status === 'PLANNED' || Object.keys(draft.payload).length === 0);
        const nextDraft = remaining[0];
        setProgressStep(2);
        setBusyLabel(`正在准备第 ${latestPassport.platformDrafts.length - remaining.length + 1}/${latestPassport.platformDrafts.length} 份站点文案…`);
        setBusyHint(nextDraft ? `${platformNames.get(nextDraft.platformId) ?? nextDraft.platformId} · ${nextDraft.market}，完成后请你检查` : '完成后可以逐份检查和修改');
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
        append('agent', `我已经生成 ${refreshed.passport.platformDrafts.length} 份中文审校稿。接下来请逐份确认${scenePlan?.mode === 'SPLIT' ? '每套场景的文案' : ''}。`, '等待 Listing 审核', {
          kind: 'listing',
          items: refreshed.passport.platformDrafts.map((draft) => {
            const payload = isListingDraftPayload(draft.payload) ? draft.payload : null;
            return {
              id: draft.id,
              label: `${platformNames.get(draft.platformId) ?? draft.platformId}${scenePlan?.mode === 'SPLIT' ? ` · ${sceneLabel(draft.sceneId, scenePlan)}` : ''}`,
              value: payload ? listingTitle(payload) : '等待生成',
              detail: `${draft.market} · 中文审校稿`,
              status: draft.status === 'APPROVED' ? '已确认' : '待审核',
            };
          }),
        });
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true, drafts: refreshed.passport.platformDrafts.length }, checkpoint: true };
      }
      if (name === 'trim_product_video') {
        let args:Record<string,unknown>={};
        try { args=JSON.parse(call.function.arguments); } catch { throw new Error('视频裁剪参数无效'); }
        setBusyLabel('正在按你的要求调整视频…'); setBusyHint('视频处理可能需要几分钟，完成后可以预览');
        const response=await fetch(`/api/tasks/${currentTask.id}/video-trims`, {
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...args,guidance:requestText}),
        });
        if(response.status===422){const clarification=await response.json() as {error:string};append('agent',clarification.error);markToolRun(call,'COMPLETED');return {result:{ok:true,needsClarification:true},checkpoint:true};}
        const plan=await responseJson<{trimId:string;sourceVideoId:string;sourceUrl:string;duration:number;start:number;end:number}>(response,'视频处理失败');
        const blob=await trimVideo({duration:plan.duration,currentSrc:plan.sourceUrl},plan.start,plan.end,()=>{});
        const form=new FormData();form.set('trimId',plan.trimId);form.set('sourceVideoId',plan.sourceVideoId);form.set('start',String(plan.start));form.set('end',String(plan.end));form.set('file',blob,blob.type==='video/webm'?'trim.webm':'trim.mp4');
        const saved=await responseJson<{id:string}>(await fetch(`/api/tasks/${currentTask.id}/video-trims`,{method:'PUT',body:form}),'视频保存失败');
        const next=[...selectedAssetsRef.current.filter(id=>!id.startsWith('video_')),saved.id];
        selectedAssetsRef.current=next;setSelectedAssets(next);
        mediaPlanRef.current=null;setMediaPlanReady(false);setPublishOpen(false);setPhase('video');setVideoRevision(v=>v+1);
        setGeneratedAssets(await fetchGeneratedAssets(currentTask.id));
        append('agent','','等待视频确认',{kind:'video',videoJobIds:[saved.id]});
        markToolRun(call,'COMPLETED');
        return {result:{ok:true,videoId:saved.id},checkpoint:true};
      }

      if (name === 'generate_product_video' || name === 'revise_product_video') {
        const revising = name === 'revise_product_video';
        const selectedImageIds = selectedAssetsRef.current.filter((id) => id.startsWith('asset_'));
        if (!selectedImageIds.length) throw new Error('请先确认要用于视频的商品图片');
        setBusyLabel('正在准备视频画面说明…');
        setBusyHint('写好后你可以先修改，再决定是否生成视频');
        const payload = await responseJson<{job:{id:string}}>(await fetch(`/api/tasks/${currentTask.id}/videos`, {
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({guidance:requestText,selectedImageIds,purpose:revising?'revision':'initial'}),
        }), '视频修改规划失败');
        setVideoRevision(v=>v+1);
        mediaPlanRef.current=null;setMediaPlanReady(false);setPublishOpen(false);
        selectedAssetsRef.current=selectedImageIds;setSelectedAssets(selectedImageIds);setPhase('video');
        append('agent','视频提示词已准备好，你可以修改；确认后再开始生成。','等待视频确认',{kind:'video',videoJobIds:[payload.job.id]});
        markToolRun(call,'COMPLETED');
        return {result:{ok:true,videoId:payload.job.id},checkpoint:true};
      }
      if (name === 'revise_media_order') {
        mediaPlanRef.current=null;setMediaPlanReady(false);setMediaGuidance(requestText);setPhase('publish');setPublishOpen(false);
        append('agent','请按最新要求重新安排封面与媒体顺序，并核对方案。','等待媒体编排确认');markToolRun(call,'COMPLETED');return {result:{ok:true,mediaReview:true},checkpoint:true};
      }
      if (name === 'generate_visual_assets') {
        const initialBrief = requestText.startsWith('我已确认图片生成需求，请生成图片') ? imageBriefRef.current : null;
        setProgressStep(3); setBusyLabel('正在按你的要求制作商品图片…'); setBusyHint('完成后你可以逐张查看、挑选或提出修改');
        const payload = await responseJson<{
          assets: GeneratedAsset[];
          summary: { total: number; completed: number; failed: number };
          retainedAssetIds?: Record<string, string>;
          decision: { targetIndices: number[] };
        }>(await fetch(`/api/tasks/${currentTask.id}/generated-assets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: true, guidance: requestText, confirmedBrief: Boolean(initialBrief), count: initialBrief?.sceneCounts ? null : initialBrief?.count ?? null, sceneCounts: initialBrief?.sceneCounts ?? null, style: initialBrief?.style ?? null, notes: initialBrief?.notes ?? null }),
        }), '视觉素材生成失败');
        const targetIndices = payload.decision.targetIndices;
        setGeneratedAssets(payload.assets);
        selectedAssetsRef.current = targetIndices.length
          ? selectedAssetsRef.current.filter((id) => id.startsWith('asset_')).flatMap((id) => payload.retainedAssetIds?.[id] ? [payload.retainedAssetIds[id]] : [])
          : [];
        const selectableIds = new Set(payload.assets.filter((asset) => asset.kind !== 'VIDEO' && asset.status === 'COMPLETED' && !asset.error).map((asset) => asset.id));
        selectedAssetsRef.current = selectedAssetsRef.current.filter((id) => selectableIds.has(id));
        setSelectedAssets(selectedAssetsRef.current);
        if (selectableIds.size === 0) throw new Error('图像模型没有生成通过验收的图片');
        setPhase('assets');
        append('agent', payload.summary.failed > 0
          ? `${payload.summary.completed} 张图片已通过验收，${payload.summary.failed} 张未通过：${payload.assets.filter((asset) => asset.status === 'FAILED').map((asset) => asset.title).join('、')}。已通过的图片可以继续使用；如还需要缺失的图片，请调整要求后重新生成。`
          : targetIndices.length ? '指定图片已更新，其余图片保持不变。请检查结果。' : scenePlan?.mode === 'SPLIT' ? '各场景图片已生成。请分别检查和挑选；确认后可为各场景生成视频。' : '图片已生成。请先检查并修改图片；确认最终图片后，才会开始生成视频。', '等待素材选择', { kind: 'assets', assets: snapshotGeneratedImages(payload.assets) });
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, summary: payload.summary }, checkpoint: true };
      }
      if (name === 'open_asset_selection') {
        const assets = await fetchGeneratedAssets(currentTask.id);
        const completed = assets.filter((asset) => asset.kind !== 'VIDEO' && asset.status === 'COMPLETED' && !asset.error);
        if (completed.length === 0) throw new Error('没有通过验收的图片，请重新生成');
        setGeneratedAssets(assets);
        setPhase('assets');
        append('agent', scenePlan?.mode === 'SPLIT' ? '各套场景图片已生成。请逐张检查，并为每套场景至少选一张；确认后可继续生成视频。' : '图片已生成。请先检查并修改图片；确认最终图片后，才会开始生成视频。', '等待素材选择', { kind: 'assets', assets: snapshotGeneratedImages(assets) });
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true }, checkpoint: true };
      }
      if (name === 'open_publish_confirmation') {
        setBusyLabel('正在安排封面和展示顺序…'); setBusyHint('完成后你可以调整图片和视频的先后顺序');
        await responseJson(await fetch(`/api/tasks/${currentTask.id}/media-plan`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({selectedAssetIds:selectedAssetsRef.current,guidance:mediaGuidance})}),'媒体编排失败');
        setPhase('publish'); setPublishOpen(false);
        mediaPlanRef.current=null;setMediaPlanReady(false);
        append('agent', '上架包已经准备完成。请确认各场景的封面和图片顺序，再检查目标站点译文；只有你明确确认后我才会调用测试交付工具。', '等待图片顺序确认', {
          kind: 'publish',
          items: [{ id: currentTask.id, label: currentTask.productName, value: `${currentTask.platforms.length} 个目标平台`, detail: `${currentTask.markets.join('、')} · 测试草稿`, status: '待确认' }],
        });
        markToolRun(call, 'COMPLETED');
        return { result: { ok: true, presented: true }, checkpoint: true };
      }
      if (name === 'publish_mock_drafts') {
        if (!publishApproved) throw new Error('发布工具缺少本轮商家明确授权');
        setProgressStep(4); setBusyLabel('正在进行平台测试交付…'); setBusyHint('不会公开上架，完成后会显示各站点结果');
        const payload = await responseJson<{
          passport: ProductPassport;
          message?: string;
          results: Array<{ platformId: string; mode: 'SHOPIFY_DEV' | 'AMAZON_SANDBOX' | 'MOCK'; targetLocale?: string; targetLanguage?: string; adminUrl?: string | null; warnings?: string[]; verification?: Array<{ field: string; status: string }>; sandboxStatus?: string; sandboxIssueCodes?: string[] }>;
        }>(await fetch(`/api/tasks/${currentTask.id}/publish-mock`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({selectedAssetIds:selectedAssetsRef.current,mediaPlanId:mediaPlanRef.current}) }), '平台测试草稿创建失败');
        setPassport(payload.passport); setPublishOpen(false); setPhase('complete');
        const shopifyCreated = payload.results.filter((item) => item.mode === 'SHOPIFY_DEV').length;
        const amazonTested = payload.results.filter((item) => item.mode === 'AMAZON_SANDBOX').length;
        const mockCreated = payload.results.filter((item) => item.mode === 'MOCK').length;
        const warningCount = payload.results.reduce((count, item) => count + (item.warnings?.length ?? 0), 0);
        const languageSummary = payload.results.map((item) => item.targetLanguage ? `${item.targetLanguage}（${item.targetLocale}）` : '').filter(Boolean).join('、');
        append('agent', `测试交付已按${languageSummary || '目标站点语言'}完成。${shopifyCreated ? `${shopifyCreated} 个 Shopify Dev Store 草稿已创建。` : ''}${amazonTested ? `${amazonTested} 个 Amazon 站点请求已发送到对应区域的官方静态沙箱；预设响应不是商品校验结果，也未创建店铺商品。` : ''}${mockCreated ? `${mockCreated} 个其他平台 Mock 草稿已记录。` : ''}${warningCount ? `另有 ${warningCount} 条说明可在发布记录中核对。` : ''}`, '测试结果已保存', {
          kind: 'publish',
          items: payload.passport.platformDrafts.filter((draft) => draft.status === 'DRAFT_CREATED').map((draft) => ({
            id: draft.id,
            label: platformNames.get(draft.platformId) ?? draft.platformId,
            value: draft.platformId === 'amazon' && isListingDraftPayload(draft.payload) && draft.payload.sandboxPublication ? '官方静态沙箱测试完成' : '平台草稿已创建',
            detail: draft.market,
            status: '成功',
          })),
        });
        for (const result of payload.results.filter((item) => item.mode === 'SHOPIFY_DEV')) {
          append('agent', `Shopify 字段核对：${(result.verification ?? []).map((item) => `${item.field}：${item.status === 'MATCH' ? '一致' : item.status === 'MISMATCH' ? '不一致' : item.status === 'NOT_SYNCED' ? '未同步' : item.status === 'PENDING' ? '平台处理中' : '核对失败'}`).join('；')}。${result.warnings?.join('；') ?? ''}`, '发布核对结果');
        }
        for (const result of payload.results.filter((item) => item.mode === 'AMAZON_SANDBOX')) {
          append('agent', `Amazon 官方静态沙箱返回 ${result.sandboxStatus ?? '未知状态'}${result.sandboxIssueCodes?.length ? `，预设问题代码：${result.sandboxIssueCodes.join('、')}` : ''}。该响应不能证明当前商品符合所选站点规则；图片和视频编排仅保存在 SKUFlow。`, 'Amazon 沙箱响应');
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
    options: { appendUser?: boolean; publishApproved?: boolean; resetHistory?: boolean; pendingFiles?: File[]; resumeHistory?: AgentModelMessage[]; allowConversation?: boolean } = {},
  ) => {
    failedTurnRef.current = null;
    setCanRetryFailedTurn(false);
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
    let history: AgentModelMessage[] = compactAgentModelHistory(options.resumeHistory
      ? [...options.resumeHistory]
      : [...retainedHistory, { role: 'user', content: modelUserText }]);
    let checkpointHistory = history;
    pauseRequestedRef.current = false; setPauseRequested(false);
    setPhase('processing'); setBusyLabel(activeTask ? '收到，正在继续处理这件商品…' : '收到，正在看你的要求…'); setBusyHint(activeTask ? '需要你确认时，会把内容展示出来' : '稍后给你答复'); setError('');
    try {
      for (let step = 0; step < 20; step += 1) {
        history = compactAgentModelHistory(history);
        if (pauseRequestedRef.current) {
          modelHistory.current = history;
          setPhase('idle');
          append('agent', '已按你的要求暂停。当前进度已保存，随时告诉我「继续」，或点「重试当前步骤」接着跑。', '已暂停');
          await persistConversation(activeTask?.id ?? null, 'ACTIVE');
          return;
        }
        // Only completed model/tool exchanges are safe to replay. A failed tool call
        // must not leave an unmatched assistant tool_call in the next request.
        checkpointHistory = history;
        const payload = await responseJson<AgentOrchestratorResponse>(await fetch('/api/agent/orchestrate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            taskId: activeTask?.id,
            messages: history,
            selectedAssetIds: selectedAssetsRef.current,
            imagesConfirmed: imagesConfirmedFromMessages(messagesRef.current),
            imageBriefConfirmed: imageBriefConfirmedFromMessages(messagesRef.current),
            videoStageComplete: videoStageCompleteFromMessages(messagesRef.current),
            publishApproved: options.publishApproved === true,
            intakePresented: phase === 'intake' || toolRunsRef.current.some((run) => run.name === 'start_listing_workflow' && run.status === 'COMPLETED'),
            pendingAttachmentCount: activeFiles.length,
            requireAction: activeTask !== null && options.allowConversation !== true,
          }),
        }), 'Agent 无法决定下一步');
        history = [...history, {
          role: 'assistant',
          content: payload.message.content,
          ...(payload.message.toolCalls.length ? { toolCalls: payload.message.toolCalls } : {}),
        }];
        const nextTool = payload.message.toolCalls[0]?.function.name;
        if (payload.message.content && !['generate_visual_assets', 'open_asset_selection', 'generate_product_video', 'revise_product_video'].includes(nextTool ?? '')) {
          append('agent', payload.message.content, payload.message.toolCalls.length ? '正在处理' : undefined);
        }
        const call = payload.message.toolCalls[0];
        if (!call) {
          modelHistory.current = history;
          phaseFromState(payload.state);
          await persistConversation(activeTask?.id ?? null, payload.state.draftCount > 0 && payload.state.publishedDraftCount === payload.state.draftCount ? 'COMPLETED' : 'ACTIVE');
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
      modelHistory.current = checkpointHistory;
      failedTurnRef.current = {
        task: activeTask,
        userText,
        history: checkpointHistory,
        pendingFiles: activeFiles,
        publishApproved: options.publishApproved === true,
        allowConversation: options.allowConversation === true,
      };
      setCanRetryFailedTurn(true);
      setError(message); setPhase('error');
      if (!message.includes('连续 3 次未通过画面验收')) append('agent', `处理时遇到问题：${message}`, '任务已暂停');
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
    const failed = failedTurnRef.current;
    if (failed) {
      await runAgentTurn(failed.task, failed.userText, {
        appendUser: false,
        pendingFiles: failed.pendingFiles,
        publishApproved: failed.publishApproved,
        allowConversation: failed.allowConversation,
        resumeHistory: failed.history,
      });
      return;
    }
    if (task && phase === 'error') {
      const lastRequest = [...messagesRef.current].reverse().find((message) => message.role === 'user');
      if (lastRequest) {
        await runAgentTurn(task, lastRequest.text, { appendUser: false, resumeHistory: modelHistory.current });
        return;
      }
    }
    if (task && (phase === 'error' || phase === 'resume') && imageBriefConfirmedFromMessages(messagesRef.current) && !imagesConfirmedFromMessages(messagesRef.current)) {
      try {
        const available = await fetchGeneratedAssets(task.id);
        if (available.some((asset) => asset.kind !== 'VIDEO' && asset.status === 'COMPLETED' && !asset.error)) {
          setGeneratedAssets(available);
          setError(''); setCanRetryFailedTurn(false); failedTurnRef.current = null;
          setPhase('assets');
          append('agent', '已找到保存的候选图片。请检查是否符合最新要求；不满意可以直接告诉我修改。', '等待素材选择', { kind: 'assets', assets: snapshotGeneratedImages(available) });
          await persistConversation(task.id);
          return;
        }
      } catch { /* If saved images cannot be read, retry the failed step below. */ }
    }
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

  const confirmScenePlan = async () => {
    if (!task || actionBusy) return;
    setActionBusy(true); setError('');
    setPhase('processing'); setBusyLabel('正在安排不同场景…'); setBusyHint('每套场景都会有自己的图片和文案方向');
    try {
      const payload = await responseJson<{ plan: ScenePlan; passport: ProductPassport }>(await fetch(`/api/tasks/${task.id}/scene-plan`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: sceneMode, count: sceneMode === 'SINGLE' ? 1 : sceneCount, directions: sceneDirections.slice(0, sceneCount) }),
      }), '场景方案保存失败');
      setScenePlan(payload.plan); setPassport(payload.passport);
      const summary = payload.plan.mode === 'SINGLE' ? '按一套方案上新' : `制作 ${payload.plan.scenes.length} 套场景：${payload.plan.scenes.map((scene) => scene.name).join('、')}`;
      append('user', summary, '场景方案已确认');
      await runAgentTurn(task, `我已确认${summary}。请为每套场景分别准备与图片方向匹配的 Listing 文案。`, { appendUser: false });
    } catch (caught) {
      setPhase('scene_plan');
      setError(caught instanceof Error ? caught.message : '场景方案保存失败');
    } finally { setActionBusy(false); }
  };

  const refreshAfterListing = async () => {
    if (!task) return false;
    try {
      const currentPassport = await fetchPassport(task.id);
      setPassport(currentPassport);
      const allApproved = currentPassport.platformDrafts.length > 0 && currentPassport.platformDrafts.every((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED');
      setPhase(allApproved ? 'image_brief' : 'listing');
      return allApproved;
    } catch { return false; /* Listing editor already reports its own errors. */ }
  };

  const proceedToAssets = async () => {
    if (!await refreshAfterListing() || !task) return;
    try {
      const available = await fetchGeneratedAssets(task.id);
      setGeneratedAssets(available);
      if (available.some((asset) => asset.kind !== 'VIDEO')) { setPhase('assets'); return; }
      setPhase('image_brief');
      if (messagesRef.current.at(-1)?.meta !== '等待图片需求') {
        append('agent', scenePlan?.mode === 'SPLIT' ? `各套 Listing 已确认。请为每套场景选择要生成几张图片，也可以补充共同的视觉风格。` : 'Listing 已确认。生成图片前，你希望要几张？想要什么风格或场景？也可以交给我根据商品和平台规划。', '等待图片需求');
        await persistConversation(task.id);
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : '图片生成准备失败'); }
  };

  const submitImageBrief = async (notesOverride?: string, countOverride?: number | null) => {
    if (!task || phase === 'processing') return;
    const sceneCounts = scenePlan?.mode === 'SPLIT' ? Object.fromEntries(scenePlan.scenes.map((scene) => [scene.id, sceneImageCounts[scene.id] ?? scene.imageCount ?? 1])) : null;
    const brief: ImageBrief = { count: sceneCounts ? Object.values(sceneCounts).reduce((total, count) => total + count, 0) : countOverride === undefined ? imageBriefCount : countOverride, sceneCounts, style: imageBriefStyle.trim(), notes: (notesOverride ?? imageBriefNotes).trim() };
    if (sceneCounts && scenePlan) setScenePlan({ ...scenePlan, scenes: scenePlan.scenes.map((scene) => ({ ...scene, imageCount: sceneCounts[scene.id] })) });
    imageBriefRef.current = brief;
    const sceneSummary = sceneCounts && scenePlan?.mode === 'SPLIT' ? `各场景张数：${scenePlan.scenes.map((scene) => `${scene.name} ${sceneCounts[scene.id]} 张`).join('、')}；` : '';
    const request = `我已确认图片生成需求，请生成图片。${sceneSummary}数量：${brief.count == null ? '由 Agent 决定' : `${brief.count} 张`}；风格：${brief.style || '由 Agent 决定'}；其他要求：${brief.notes || '无'}。只生成图片，等我确认图片后再生成视频。`;
    append('user', request, '图片需求已确认');
    await runAgentTurn(task, request, { appendUser: false });
  };

  const confirmAssets = async (skipVideo = false) => {
    const available=task?await fetchGeneratedAssets(task.id):generatedAssets;
    setGeneratedAssets(available);
    const chosen = available.filter((asset) => asset.kind !== 'VIDEO' && asset.status === 'COMPLETED' && !asset.error && selectedAssetsRef.current.includes(asset.id));
    if (!chosen.length) throw new Error('请先选择至少一张图片');
    if (scenePlan?.mode === 'SPLIT') {
      const missing = scenePlan.scenes.filter((scene) => !chosen.some((asset) => asset.sceneId === scene.id));
      if (missing.length) throw new Error(`请为这些场景各选至少一张图片：${missing.map((scene) => scene.name).join('、')}`);
    }
    selectedAssetsRef.current = chosen.map((asset) => asset.id);
    setSelectedAssets(selectedAssetsRef.current);
    append('user', skipVideo ? `已确认 ${chosen.length} 张图片，本次不生成视频` : `已确认 ${chosen.length} 张图片，准备视频创意`, skipVideo ? '视频阶段已完成' : '图片已确认', {
      kind: 'assets',
      items: chosen.map((asset) => ({ id: asset.id, label: assetKindLabel(asset.kind), value: asset.title, detail: asset.note, status: '已选择' })),
    });
    if (skipVideo) {
      if (task) await runAgentTurn(task, '我已确认图片，本次不需要视频，请进入最终交付确认。', { appendUser: false });
      return;
    }
    setPhase('video');
    append('agent', scenePlan?.mode==='SPLIT'?'可以为每个场景分别生成视频，也可以只用图片继续。选择场景，确认提示词后再生成视频。':'你想怎样准备视频提示词？可以交给 AI 拟稿，也可以自己填写。确认提示词后再生成视频。', '等待视频确认');
    await persistConversation(task?.id ?? null);
  };

  const confirmVideo = async (skipVideo = false) => {
    if (!task) return;
    const available = await fetchGeneratedAssets(task.id);
    setGeneratedAssets(available);
    const imageIds = selectedAssetsRef.current.filter((id) => id.startsWith('asset_'));
    const chosenVideo = available.filter((asset) => asset.kind === 'VIDEO' && asset.status === 'COMPLETED' && selectedAssetsRef.current.includes(asset.id));
    if (!skipVideo && !chosenVideo.length) throw new Error('请先选择已生成的视频，或选择只用图片继续');
    selectedAssetsRef.current = [...imageIds, ...(skipVideo ? [] : chosenVideo.map((asset) => asset.id))];
    setSelectedAssets(selectedAssetsRef.current);
    append('user', skipVideo ? '本次只使用已确认的图片' : `已确认 ${chosenVideo.length} 条视频`, '视频阶段已完成');
    await runAgentTurn(task, '图片与视频阶段已完成，请进入最终交付确认。', { appendUser: false });
  };

  const returnToVideo = async () => {
    if (!task) return;
    mediaPlanRef.current = null;
    setMediaPlanReady(false);
    setPublishOpen(false);
    setPhase('video');
    setVideoRevision((current) => current + 1);
    append('agent', scenePlan?.mode === 'SPLIT' ? '可以为每套场景分别生成视频。确认提示词后才会开始生成；不需要的场景可以保留图片。' : '可以继续生成商品视频。确认提示词后才会开始生成。', '等待视频确认');
    await persistConversation(task.id);
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

  const newConversation = async (openAgentHome = false) => {
    try {
      if (openAgentHome && phase === 'idle' && messagesRef.current.length === 1 && messagesRef.current[0]?.id === 'welcome') {
        showWorkspace('agent');
        return;
      }
      await persistConversation();
      await createConversation();
      if (openAgentHome) showWorkspace('agent');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '新建会话失败');
    }
  };

  const signOutLocal = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.assign('/login');
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
          setPhase('loading'); setBusyLabel('正在打开相邻会话…'); setBusyHint('');
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

  const renameConversation = async (id: string) => {
    const title = renameValue.trim();
    if (!title) { setRenamingId(null); return; }
    try {
      await responseJson<{ conversation: AgentConversationRecord }>(await fetch(`/api/conversations/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }),
      }), '会话重命名失败');
      setConversations((current) => current.map((item) => item.id === id ? { ...item, title } : item));
      setRenamingId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '会话重命名失败');
    }
  };

  const toggleConversationStatus = async (item: ConversationSummary) => {
    const nextStatus = item.status === 'COMPLETED' ? 'ACTIVE' : 'COMPLETED';
    setStatusBusyId(item.id);
    try {
      await responseJson<{ conversation: AgentConversationRecord }>(await fetch(`/api/conversations/${item.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: nextStatus }),
      }), '会话状态更新失败');
      setConversations((current) => current.map((row) => row.id === item.id ? { ...row, status: nextStatus } : row));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '会话状态更新失败');
    } finally {
      setStatusBusyId(null);
    }
  };

  const sendMessage = async () => {
    const typedText = composer.trim();
    if (!typedText && pendingFiles.length === 0) return;
    const text = typedText || '请查看我随消息发送的这些附件。';
    const filesForTurn = [...pendingFiles];
    setComposer('');
    await runAgentTurn(task, text, { pendingFiles: filesForTurn, allowConversation: phase === 'image_brief' || phase === 'assets' || phase === 'publish' });
  };

  const openTargetEditor = () => {
    if (!task || publishedCount > 0 || phase === 'processing') return;
    targetReturnPhase.current = phase === 'error' ? 'resume' : phase;
    failedTurnRef.current = null;
    setCanRetryFailedTurn(false);
    setError('');
    setContextOpen(false);
    setPublishOpen(false);
    setTargetEditorOpen(true);
    setPhase('resume');
  };

  const targetEditorSaved = async () => {
    if (!task) return;
    const refreshed = await refreshTaskState(task.id);
    mediaPlanRef.current = null; setMediaPlanReady(false);
    selectedAssetsRef.current = []; setSelectedAssets([]);
    imageBriefRef.current = null;
    setImageBriefCount(null); setSceneImageCounts({}); setImageBriefStyle(''); setImageBriefNotes('');
    setTargetEditorOpen(false);
    setPhase('resume');
    append('agent', `已更新为 ${refreshed.passport.platformDrafts.map((draft) => `${platformNames.get(draft.platformId) ?? draft.platformId} ${draft.market}`).join('、')}。请继续生成新平台的 Listing。`, '目标已更新');
    await persistConversation(task.id);
  };

  const toggleAsset = (id: string) => {
    if (!id.startsWith('video_') && !generatedAssets.some((asset) => asset.id === id && asset.kind !== 'VIDEO' && asset.status === 'COMPLETED' && !asset.error)) return;
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
  const joinIntakeToLastAgentReply = phase === 'intake' && messages.at(-1)?.role === 'agent';
  const joinImageBriefToLastAgentReply = phase === 'image_brief' && messages.at(-1)?.role === 'agent' && messages.at(-1)?.meta === '等待图片需求';
  const joinAssetsToLastAgentReply = phase === 'assets' && messages.at(-1)?.role === 'agent'
    && messages.at(-1)?.meta === '等待素材选择';
  const joinVideoToLastAgentReply = phase === 'video' && messages.at(-1)?.role === 'agent'
    && (messages.at(-1)?.meta === '视频生成中' || messages.at(-1)?.meta === '等待视频确认');
  const selectedVideoSources = selectedAssets.filter((id) => id.startsWith('asset_'));

  const scenePlanCard = phase === 'scene_plan' && <div className="scene-plan-card">
    <div className="scene-plan-heading"><span>上新方式</span><h3>这件商品要做几套场景？</h3><p>同一件商品可以用不同使用场景展示。每套会分别准备图片和相呼应的文案，商品事实保持一致。</p></div>
    <div className="scene-plan-modes" role="group" aria-label="选择上新方式">
      <button type="button" className={sceneMode === 'SINGLE' ? 'selected' : ''} aria-pressed={sceneMode === 'SINGLE'} onClick={() => setSceneMode('SINGLE')}><b>常规上新</b><small>每个站点一套内容</small></button>
      <button type="button" className={sceneMode === 'SPLIT' ? 'selected' : ''} aria-pressed={sceneMode === 'SPLIT'} onClick={() => setSceneMode('SPLIT')}><b>场景裂变</b><small>每个站点多套图文方案</small></button>
    </div>
    {sceneMode === 'SPLIT' && <div className="scene-plan-options"><label>做几套场景<select value={sceneCount} onChange={(event) => setSceneCount(Number(event.target.value))}>{[2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count} 套</option>)}</select></label><p>可以写下你想测试的方向；留空的场景由智能体规划。</p><div className="scene-plan-directions">{Array.from({ length: sceneCount }, (_, index) => <label key={index}>场景 {index + 1}<input value={sceneDirections[index] ?? ''} onChange={(event) => setSceneDirections((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} maxLength={300} placeholder="例如：办公室通勤；留空由智能体规划" /></label>)}</div></div>}
    <footer><span>{sceneMode === 'SPLIT' ? `预计生成 ${sceneCount} 套 × 每个已选站点的独立文案` : '沿用当前单套流程'}</span><button type="button" disabled={actionBusy} onClick={() => void confirmScenePlan()}>{actionBusy ? '正在安排…' : '确认并继续'}</button></footer>
  </div>;
  const intakeCard = phase === 'intake' && (preferencesLoaded
    ? <div className="chat-action-card intake"><div className="action-card-head"><span>补充必要信息</span><b>只需确认尚未提供的信息</b><p>也可以直接在对话中补充，已有资料会继续使用。</p></div><div className="embedded-intake"><TaskIntake key={JSON.stringify(inferConversationTargets(modelHistory.current)) + JSON.stringify(preferences?.preferredTargets) + pendingFiles.map((file) => file.name + file.size).join()} onNext={handleIntakeComplete} agentManaged initialFiles={pendingFiles} initialTargets={inferConversationTargets(modelHistory.current)} preferredTargets={preferences?.preferredTargets} /></div></div>
    : <div className="chat-action-card intake">正在读取店铺偏好…</div>);
  const imageBriefCard = phase === 'image_brief' && <div className="image-brief-card">
    <div className="image-brief-heading"><span>图片生成需求</span><h3>先确定图片方向</h3><p>{scenePlan?.mode === 'SPLIT' ? '每套场景可单独选择图片张数，图片会按对应文案规划。' : preferences?.visualStyle ? `默认沿用店铺视觉偏好：${preferences.visualStyle}。本轮可直接覆盖。` : '告诉我需要几张，以及希望呈现的风格或场景。留空的部分由 Agent 根据商品与平台规划。'}</p></div>
    <div className="image-brief-fields">
      {scenePlan?.mode === 'SPLIT' ? <fieldset className="scene-image-counts"><legend>每套场景生成几张图片</legend>{scenePlan.scenes.map((scene) => <div className="scene-image-count-row" key={scene.id}><div><b>{scene.name}</b><small>{scene.visualBrief}</small></div><div className="image-brief-counts" role="group" aria-label={`${scene.name}图片张数`}>{[1, 2, 3, 4, 5, 6].map((count) => <button key={count} type="button" className={(sceneImageCounts[scene.id] ?? scene.imageCount ?? 1) === count ? 'selected' : ''} aria-pressed={(sceneImageCounts[scene.id] ?? scene.imageCount ?? 1) === count} onClick={() => setSceneImageCounts((current) => ({ ...current, [scene.id]: count }))}>{count} 张</button>)}</div></div>)}<small>共 {scenePlan.scenes.reduce((total, scene) => total + (sceneImageCounts[scene.id] ?? scene.imageCount ?? 1), 0)} 张；每套场景分别生成，并在下一步挑选。</small></fieldset> : <fieldset><legend>生成几张图片</legend><div className="image-brief-counts">{[null, 1, 2, 3, 4, 5, 6].map((count) => <button key={count ?? 'auto'} type="button" className={imageBriefCount === count ? 'selected' : ''} aria-pressed={imageBriefCount === count} onClick={() => setImageBriefCount(count)}>{count == null ? '智能决定' : `${count} 张`}</button>)}</div><small>按你的需求规划图片内容；封面与顺序稍后再确认。</small></fieldset>}
      <label>图片风格<input value={imageBriefStyle} onChange={(event) => setImageBriefStyle(event.target.value)} maxLength={200} placeholder="例如：自然生活感、简洁高级、户外通勤" /></label>
      <label>其他要求<textarea rows={3} value={imageBriefNotes} onChange={(event) => setImageBriefNotes(event.target.value)} maxLength={500} placeholder="例如：不要细节图；希望有一张真人穿搭图" /></label>
    </div>
    <footer><span>{scenePlan?.mode === 'SPLIT' ? '每套图文方案会独立用于对应草稿' : '先生成并确认图片，再开始视频'}</span><button type="button" onClick={() => void submitImageBrief()}>{scenePlan?.mode === 'SPLIT' ? '按各场景张数生成图片' : imageBriefCount == null && !imageBriefStyle.trim() && !imageBriefNotes.trim() ? '交给 Agent 规划图片' : '按这些要求生成图片'}</button></footer>
  </div>;
  const assetCard = phase === 'assets' && <AssetConversationCard assets={generatedAssets} selected={selectedAssets} onToggle={toggleAsset} onConfirm={() => void confirmAssets().catch((caught) => setError(caught instanceof Error ? caught.message : '图片确认失败'))} onSkipVideo={() => void confirmAssets(true).catch((caught) => setError(caught instanceof Error ? caught.message : '图片确认失败'))} onAdjustCounts={scenePlan?.mode === 'SPLIT' ? () => { setPhase('image_brief'); append('agent', '可以重新选择每套场景的图片张数。确认后会按新张数重新生成。', '等待图片需求'); } : undefined} scenePlan={scenePlan} splitMode={scenePlan?.mode === 'SPLIT'} />;
  const videoCard = phase === 'video' && task && <div className={`video-stage-card${scenePlan?.mode==='SPLIT'?' split-video-stage':''}`}>{scenePlan?.mode==='SPLIT'?scenePlan.scenes.map(scene=><section className="scene-video-stage" key={scene.id}><h3>{scene.name}</h3><VideoConversation taskId={task.id} revision={videoRevision} selected={selectedAssets} onToggle={toggleAsset} selectable showSuggestion sceneId={scene.id} sourceImageIds={selectedVideoSources.filter(id=>generatedAssets.some(asset=>asset.id===id&&asset.sceneId===scene.id))} onJobCreated={recordVideoJob}/></section>):<VideoConversation taskId={task.id} revision={videoRevision} selected={selectedAssets} onToggle={toggleAsset} selectable showSuggestion sourceImageIds={selectedVideoSources} jobIds={messages.at(-1)?.videoJobIds} onJobCreated={recordVideoJob} />}<footer><button type="button" onClick={() => void confirmVideo(true).catch((caught) => setError(caught instanceof Error ? caught.message : '视频确认失败'))}>只用图片继续</button><button className="primary" type="button" disabled={!selectedAssets.some((id) => id.startsWith('video_'))} onClick={() => void confirmVideo().catch((caught) => setError(caught instanceof Error ? caught.message : '视频确认失败'))}>确认所选视频并继续</button></footer></div>;

  const composerAttachments = pendingFiles.length > 0 && <div className="composer-attachments" aria-label="待上传附件">{pendingFiles.map((file, index) => <div className="composer-attachment" key={`${file.name}:${file.size}`}><span>{file.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'}</span><div><b>{file.name}</b><small>{formatBytes(file.size)}</small></div><button type="button" aria-label={`移除附件：${file.name}`} onClick={() => setPendingFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}</div>;

  const composerPlaceholder = phase === 'processing'
    ? '正在处理你的要求，请稍等…'
    : pendingFiles.length
      ? '告诉 Agent 要处理附件，还是用这些资料上新...'
        : phase === 'idle'
          ? '描述你要上新的商品、目标平台，或先上传商品资料...'
        : phase === 'image_brief'
          ? '也可以直接描述图片数量、风格和其他要求...'
        : phase === 'assets'
          ? '图片不满意可以直接说：换成户外场景、不要模特...'
          : phase === 'video'
            ? '视频不满意可以直接描述修改要求...'
          : '直接告诉 Agent 你的要求...';

  return <main className="agent-shell agent-shell-v2" data-workspace={workspace} style={{ '--agent-rail-width': `${railWidth}px` } as CSSProperties}>
    <aside className="agent-rail" aria-label="SKUFlow 导航">
      <div className="agent-brand"><span>S</span><div><b>SKUFlow</b><small>Agentic Commerce</small></div></div>
      <nav className="agent-primary-nav" aria-label="工作区">
        <button type="button" className={workspace === 'agent' ? 'active' : ''} aria-current={workspace === 'agent' ? 'page' : undefined} disabled={phase === 'processing' || phase === 'loading'} onClick={() => void newConversation(true)}><span>⌂</span>AI 上新</button>
        <button type="button" onClick={() => showWorkspace('agent')}><span>□</span>任务记录</button>
        <button type="button" className={workspace === 'batch' ? 'active' : ''} aria-current={workspace === 'batch' ? 'page' : undefined} onClick={() => showWorkspace('batch')}><span>▦</span>批量上新</button>
        <button type="button" disabled={workspace === 'batch' || phase === 'idle'} onClick={() => setContextOpen(true)}><span>◫</span>任务进度</button>
      </nav>
      <div className="agent-rail-label">最近对话</div>
      <div className="conversation-list" id="conversation-list">{conversations.map((item) => <div className={`conversation-item ${item.id === conversationId ? 'active' : ''}`} key={item.id}>
        {renamingId === item.id ? <form className="conversation-rename" onSubmit={(event) => { event.preventDefault(); void renameConversation(item.id); }}>
          <input autoFocus value={renameValue} maxLength={60} aria-label="会话名称" onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenamingId(null); }} />
          <button className="conversation-action" type="submit" title="确认重命名" aria-label="确认重命名"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg></button>
          <button className="conversation-action" type="button" title="取消" aria-label="取消重命名" onClick={() => setRenamingId(null)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12Z"/></svg></button>
        </form> : <>
          <button className="conversation-open" type="button" disabled={phase === 'processing'} onClick={() => void openConversation(item.id)}><span>{item.id === conversationId ? '◉' : '○'}</span><div><b>{item.title}</b><small>{item.status === 'COMPLETED' ? '已完成' : item.taskId ? '进行中' : '等待资料'}</small></div></button>
          <div className="conversation-actions">
            <button className="conversation-action" type="button" disabled={phase === 'processing'} title="更多操作" aria-label={`会话操作：${item.title}`} aria-haspopup="menu" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setItemMenu({ id: item.id, x: rect.right, y: rect.bottom }); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/></svg></button>
          </div>
        </>}
      </div>)}</div>
      <div className="agent-rail-links">
        <button type="button" title="帮助中心"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm1-4h-2v2h2v-2Zm1.9-5.6c-.3.4-.8.8-1.4 1.1-.4.2-.5.4-.5.8v.7h-2v-.9c0-1 .5-1.7 1.4-2.2.5-.3.8-.5.9-.8.2-.3.3-.6.3-1 0-.9-.7-1.6-1.6-1.6s-1.6.7-1.6 1.6H9c0-2 1.3-3.6 3-3.6s3 1.4 3 3.2c0 .7-.2 1.3-.6 1.7Z"/></svg><span>帮助中心</span></button>
        <button type="button" title="偏好设置" disabled={!preferencesLoaded} onClick={() => setPreferencesOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13c.1-.3.1-.7.1-1s0-.7-.1-1l2.1-1.7c.2-.2.3-.5.1-.7l-2-3.5c-.1-.2-.4-.3-.7-.2l-2.5 1c-.5-.4-1.1-.7-1.7-1L14.2 2c0-.3-.3-.5-.5-.5h-4c-.2 0-.5.2-.5.5l-.4 2.7c-.6.2-1.2.5-1.7 1l-2.5-1c-.2-.1-.5 0-.7.2l-2 3.5c-.1.2-.1.5.1.7L4.1 11c0 .3-.1.7-.1 1s0 .7.1 1l-2.1 1.7c-.2.2-.3.5-.1.7l2 3.5c.1.2.4.3.7.2l2.5-1c.5.4 1.1.7 1.7 1l.4 2.7c0 .3.3.5.5.5h4c.2 0 .5-.2.5-.5l.4-2.7c.6-.2 1.2-.5 1.7-1l2.5 1c.2.1.5 0 .7-.2l2-3.5c.1-.2.1-.5-.1-.7L19.4 13ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg><span>偏好设置</span></button>
        <button type="button" className="agent-rail-upgrade" title="升级计划"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.8 5.7L19.5 9l-4.6 3.4 1.7 5.6L12 14.7l-4.6 3.3 1.7-5.6L4.5 9l5.7-1.3L12 2Z"/></svg><span>升级计划</span></button>
      </div>
      <div className="agent-user"><span>{avatar}</span><div><a href="/login" title="查看账号"><b>{account.name}</b></a><small title={account.phone || account.username || account.email}>{account.phone || account.username || account.email}</small></div>{account.provider === 'local' ? <button className="agent-user-signout" type="button" onClick={() => void signOutLocal()} title="退出登录" aria-label="退出登录"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5V3Zm4 4-1.4 1.4L15.2 11H8v2h7.2l-2.6 2.6L14 17l5-5-5-5Z"/></svg></button> : <a className="agent-user-signout" href="/signout-with-chatgpt?return_to=/login" target="_top" title="退出登录" aria-label="退出登录"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5V3Zm4 4-1.4 1.4L15.2 11H8v2h7.2l-2.6 2.6L14 17l5-5-5-5Z"/></svg></a>}</div>
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

    {batchOpened && <section className="agent-batch-panel" hidden={workspace !== 'batch'} aria-label="批量上新控制台">
      <div className="agent-batch-panel-head"><div><small>SKUFlow 工作区</small><b>批量上新</b></div><button type="button" aria-label="收起批量上新控制台" onClick={() => showWorkspace('agent')}>×</button></div>
      <BatchWorkspace embedded preferredTargets={preferences?.preferredTargets} activeConversationId={conversationId} conversationSwitchDisabled={phase === 'processing'} onOpenConversation={(id) => void openConversation(id)} />
    </section>}

    <section className="agent-main" id="agent-workspace">
      <header className="agent-topbar">
        <div><span className="agent-online"><i /> SKUFlow Agent</span><h1>{task && task.productName !== PENDING_PRODUCT_NAME ? task.productName : phase === 'idle' ? 'AI 上新工作台' : '创建商品上新任务'}</h1></div>
        <div className="agent-topbar-actions">
          <button className="topbar-batch-switch" type="button" aria-expanded={workspace === 'batch'} onClick={() => showWorkspace(workspace === 'batch' ? 'agent' : 'batch')}>{workspace === 'batch' ? '收起批量台' : '批量上新 →'}</button>
            {phase !== 'idle' && <div className="agent-model"><span>百炼</span><b>qwen3.8-max</b></div>}
            {task && publishedCount === 0 && <button className="context-toggle" type="button" disabled={phase === 'processing'} onClick={openTargetEditor}>修改平台/站点</button>}
            {phase !== 'idle' && <button className="context-toggle" type="button" aria-expanded={contextOpen} onClick={() => setContextOpen((open) => !open)}><span>{currentStep + 1}/5</span>任务进度</button>}
            <button className="topbar-new-chat" type="button" disabled={phase === 'processing'} onClick={() => void newConversation()}><span>+</span> 新建对话</button>
        </div>
      </header>

      <div className={`agent-chat-layout ${showWelcomeWorkspace ? 'idle' : ''} ${contextOpen ? 'context-open' : ''}`}>
        <section className="agent-thread" aria-label="Agent 对话">
          {!showWelcomeWorkspace && workspace !== 'batch' && <div className="agent-date">今天 · Agent 工作区</div>}
          {!showWelcomeWorkspace && workspace === 'batch' && phase === 'resume' && messages.length > 0 && <details className="batch-conversation-history"><summary>查看历史消息（{messages.length}）</summary>{messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}><span className="chat-avatar">{message.role === 'agent' ? 'AI' : avatar}</span><div className={message.kind && message.kind !== 'text' ? 'rich-message-bubble' : ''}>{!(message.kind === 'assets' && message.assets?.length) && <RichMessageContent message={currentListingMessage(message, passport)} />}{message.kind === 'assets' && message.assets && message.assets.length > 0 && <AssetConversationCard assets={displaySnapshots(message.assets)} selected={[]} onToggle={() => {}} onConfirm={() => {}} onSkipVideo={() => {}} readOnly />}{task && message.kind === 'video' && Boolean(message.videoJobIds?.length) && <VideoConversation taskId={task.id} revision={videoRevision} selected={selectedAssets} onToggle={toggleAsset} selectable jobIds={message.videoJobIds} />}</div></article>)}</details>}
          {!showWelcomeWorkspace && !(workspace === 'batch' && phase === 'resume') && messages.map((message, index) => {
            const joinsIntake = joinIntakeToLastAgentReply && index === messages.length - 1;
            const joinsImageBrief = joinImageBriefToLastAgentReply && index === messages.length - 1;
            const joinsAssets = joinAssetsToLastAgentReply && index === messages.length - 1;
            const joinsVideo = joinVideoToLastAgentReply && index === messages.length - 1;
            const joinsAction = joinsIntake || joinsImageBrief || joinsAssets || joinsVideo;
            const richClass = message.kind && message.kind !== 'text' ? 'rich-message-bubble' : '';
            const displayedMessage = currentListingMessage(message, passport);
            return <article className={`chat-message ${message.role}${joinsAction ? ' joined-action' : ''}${message.kind === 'video' ? ' video-round-message' : ''}`} key={message.id}>
              <span className="chat-avatar">{message.role === 'agent' ? 'AI' : avatar}</span>
              <div className={`${richClass}${joinsAction ? ' joined-action-bubble' : ''}`}>
                {joinsAssets || (message.kind === 'assets' && message.assets?.length) ? null : joinsAction ? <div className="joined-message-copy"><RichMessageContent message={displayedMessage} /></div> : <RichMessageContent message={displayedMessage} />}
                {joinsIntake && intakeCard}
                {joinsImageBrief && imageBriefCard}
                {joinsAssets && assetCard}
                {!joinsAssets && message.kind === 'assets' && message.assets && message.assets.length > 0 && <AssetConversationCard assets={displaySnapshots(message.assets)} selected={[]} onToggle={() => {}} onConfirm={() => {}} onSkipVideo={() => {}} readOnly />}
                {!joinsVideo && task && message.kind === 'video' && Boolean(message.videoJobIds?.length) && <VideoConversation taskId={task.id} revision={videoRevision} selected={selectedAssets} onToggle={toggleAsset} selectable jobIds={message.videoJobIds} />}
                {joinsVideo && videoCard}
              </div>
            </article>;
          })}

          {showWelcomeWorkspace && <div className="agent-welcome-workspace">
            <div className="agent-welcome-copy"><small>欢迎使用 SKUFlow</small><h2>今天想上新什么商品？</h2><p>把商品图片、参数表和说明文档交给我，我会整理属性、生成各平台 Listing，并在关键节点请你确认。</p></div>
            <div className={`welcome-composer ${pendingFiles.length ? 'has-files' : ''} ${dragActive ? 'drag-active' : ''}`} {...composerDropHandlers}>
              <input ref={composerFileInput} className="visually-hidden" type="file" multiple accept={COMPOSER_FILE_ACCEPT} onChange={(event) => { if (event.target.files) addComposerFiles(event.target.files); event.currentTarget.value = ''; }} />
              {composerAttachments}
              <textarea rows={4} className="agent-composer-input" value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={composerPlaceholder} />
              <div className="welcome-composer-toolbar">
                <div><span className="composer-mode">◇ 智能规划</span><button type="button" title="可一次选择多个文件，也可以直接拖进对话框" onClick={() => composerFileInput.current?.click()}>＋ 添加资料</button><button type="button" title="可一次选择多张图片，也可以直接拖进对话框" onClick={() => composerFileInput.current?.click()}>▧ 上传图片</button><button type="button" disabled title="即将支持">⌁ 语音消息</button></div>
                <small>{composer.length}/2000</small>
                <button className="send" type="button" aria-label="发送消息" onClick={() => void sendMessage()} disabled={!composer.trim() && pendingFiles.length === 0}>↑</button>
              </div>
            </div>
            <div className="ready-prompt-title">从常用任务开始</div>
            <div className="agent-starters" aria-label="快速开始">
              <button type="button" onClick={() => setComposer('我想上新一款商品')}><span className="starter-icon"><StarterIcon kind="new" /></span><b>上新一款商品</b><small>上传商品资料，由 Agent 完成多平台上新流程</small></button>
              <button type="button" onClick={() => setComposer('请帮我检查这份商品资料')}><span className="starter-icon"><StarterIcon kind="analyze" /></span><b>分析商品资料</b><small>提取属性，并识别图片与文档中的事实冲突</small></button>
              <button type="button" onClick={() => setComposer('我想了解不同平台的 Listing 要求')}><span className="starter-icon"><StarterIcon kind="rules" /></span><b>咨询平台规则</b><small>了解平台字段、内容规范与发布限制</small></button>
              <button type="button" onClick={() => setComposer('请帮我优化这款商品的 Listing')}><span className="starter-icon"><StarterIcon kind="optimize" /></span><b>优化 Listing</b><small>改写标题、卖点、描述与平台营销内容</small></button>
            </div>
          </div>}

          {phase === 'loading' && <div className="agent-running-card"><span className="agent-spinner" /><div><b>{busyLabel}</b><small>{busyHint || '我会根据任务状态继续上次的工作。'}</small></div></div>}

          {phase === 'intake' && !joinIntakeToLastAgentReply && intakeCard}

          {phase === 'resume' && task && !targetEditorOpen && <div className={`chat-action-card resume${workspace === 'batch' ? ' batch-resume' : ''}`}><div className="resume-symbol">↻</div><div>{workspace === 'batch' ? <><span>当前商品</span><h3>继续处理任务</h3></> : <><span>可继续的任务</span><h3>{task.productName}</h3><p>{task.platforms.map((id) => platformNames.get(id) ?? id).join('、')} · {task.markets.join('、')}</p></>}</div><div className="resume-actions">{workspace !== 'batch' && <button className="ghost" type="button" onClick={() => void newConversation()}>新建任务</button>}<button className="primary" type="button" onClick={resumeTask}>继续处理 →</button></div></div>}

          {targetEditorOpen && task && passport && <TaskTargetEditor key={task.id} taskId={task.id} drafts={passport.platformDrafts} onSaved={targetEditorSaved} onCancel={() => { setTargetEditorOpen(false); setPhase(targetReturnPhase.current); }} />}

          {phase === 'processing' && <div className="agent-running-card"><span className="agent-spinner" /><div><b>{busyLabel}</b><small>{busyHint || '正在处理你的要求，完成后会自动展示结果。'}</small></div>{pauseRequested
            ? <em>正在等待当前步骤完成…</em>
            : <button type="button" className="agent-pause-button" title="不会打断正在执行的一步，当前步骤完成后暂停" onClick={() => { pauseRequestedRef.current = true; setPauseRequested(true); }}>⏸ 暂停</button>}</div>}

          {phase === 'conflict' && passport && <ConflictConversationCard passport={passport} busy={actionBusy} manualValue={manualConflictValue} onManualValue={setManualConflictValue} onResolve={resolveConflict} />}

          {phase === 'scene_plan' && <article className="chat-message agent scene-plan-conversation"><span className="chat-avatar">AI</span>{scenePlanCard}</article>}

          {phase === 'listing' && task && <article className="chat-message agent listing-conversation"><span className="chat-avatar">AI</span><ListingWorkspace task={task} onAssets={proceedToAssets} onPassportChange={setPassport} conversation /></article>}

          {phase === 'image_brief' && !joinImageBriefToLastAgentReply && <article className="chat-message agent image-brief-conversation"><span className="chat-avatar">AI</span>{imageBriefCard}</article>}

          {phase === 'assets' && !joinAssetsToLastAgentReply && <article className="chat-message agent asset-conversation"><span className="chat-avatar">AI</span>{assetCard}</article>}
          {phase === 'video' && !joinVideoToLastAgentReply && <article className="chat-message agent video-stage-conversation"><span className="chat-avatar">AI</span>{videoCard}</article>}

          {phase === 'publish' && task && <article className="chat-message agent"><span className="chat-avatar">AI</span><MediaOrderReview scenePlan={scenePlan} onAddVideo={() => void returnToVideo().catch((caught) => setError(caught instanceof Error ? caught.message : '无法返回视频步骤'))} onReselect={()=>{mediaPlanRef.current=null;setMediaPlanReady(false);setPublishOpen(false);setPhase('assets');}} taskId={task.id} selectedIds={selectedAssets} guidance={mediaGuidance} onInvalidated={()=>{mediaPlanRef.current=null;setMediaPlanReady(false);setPublishOpen(false);}} onConfirmed={id=>{mediaPlanRef.current=id;setMediaPlanReady(true);setPublishOpen(true);}}/></article>}
          {phase === 'publish' && <div className="chat-action-card checkpoint final"><div className="checkpoint-icon">↗</div><div><span>最后确认</span><h3>上新内容已准备好</h3><p>检查并确认后，才会开始测试交付。</p></div><button type="button" disabled={!mediaPlanReady} onClick={() => setPublishOpen(true)}>查看并确认交付</button></div>}

          {phase === 'complete' && <div className="chat-action-card completed"><span>✓</span><div><small>测试交付已完成</small><h3>{publishedCount} 个平台结果已保存</h3><p>任务、商品事实、人工决策和测试结果均已保留追溯信息。</p></div>{task?.platforms.includes('shopify') && <button type="button" onClick={recheckShopify}>重新核对 Shopify</button>}<button className="primary" type="button" onClick={() => void newConversation()}>处理下一个商品</button></div>}

          {error && <div className="chat-error" role="alert"><b>任务暂停</b><span>{error}</span>{(canRetryFailedTurn || task) && <button type="button" onClick={resumeTask}>重试当前步骤</button>}{task && publishedCount === 0 && <button type="button" onClick={openTargetEditor}>重新选择平台/站点</button>}</div>}
          <div ref={threadEnd} />
        </section>

        {phase !== 'idle' && <>
          <button className="agent-context-scrim" type="button" aria-label="关闭任务进度" onClick={() => setContextOpen(false)} />
          <aside className="agent-context" aria-label="任务进度">
          <div className="context-head"><div><span>任务进度</span><b>{phase === 'complete' ? '已完成' : '进行中'}</b></div><button type="button" aria-label="关闭任务进度" onClick={() => setContextOpen(false)}>×</button></div>
          <ol className="agent-progress">{['接收资料', '商品理解', '文案审核', '视觉选择', '发布交付'].map((label, index) => <li className={index < currentStep || phase === 'complete' ? 'done' : index === currentStep ? 'current' : ''} key={label}><span>{index < currentStep || phase === 'complete' ? '✓' : index + 1}</span><div><b>{label}</b><small>{index < currentStep || phase === 'complete' ? '已完成' : index === currentStep ? '当前阶段' : '稍后进行'}</small></div></li>)}</ol>
          {task && <div className="context-summary"><span>当前商品</span><h3>{task.productName}</h3><div><b>{visibleFacts.length}</b><small>属性</small><b>{openConflictCount}</b><small>冲突</small><b>{approvedCount}</b><small>已审核</small></div><p>{task.platforms.map((id) => platformNames.get(id) ?? id).join(' · ')}</p></div>}
          {task && publishedCount === 0 && <div className="context-backtrack"><b>返回修改</b><button type="button" disabled={phase === 'processing'} onClick={openTargetEditor}>平台与站点</button>{passport?.platformDrafts.some((draft) => isListingDraftPayload(draft.payload)) && <button type="button" disabled={phase === 'processing'} onClick={() => { setContextOpen(false); setError(''); setPhase('listing'); }}>Listing 审核</button>}{approvedCount === passport?.platformDrafts.length && generatedAssets.some((asset) => asset.kind !== 'VIDEO') && <button type="button" disabled={phase === 'processing'} onClick={() => { setContextOpen(false); setError(''); setPhase('assets'); }}>图片选择</button>}{selectedAssets.some((id) => id.startsWith('asset_')) && <button type="button" disabled={phase === 'processing'} onClick={() => { setContextOpen(false); setError(''); setPhase('video'); }}>视频选择</button>}</div>}
          {passport && <details className="agent-evidence"><summary>查看商品事实与证据</summary><div>{visibleFacts.slice(0, 12).map((fact) => <p key={fact.id}><b>{fact.label}</b><span>{displayValue(fact.value, fact.unit)}</span></p>)}{visibleFacts.length > 12 && <small>还有 {visibleFacts.length - 12} 项属性已收起</small>}</div></details>}
          <div className="context-safety"><span>◈</span><div><b>人工门禁已开启</b><small>冲突与发布永远需要你确认</small></div></div>
          </aside>
        </>}
      </div>

      {!showWelcomeWorkspace && <footer className={`agent-composer ${pendingFiles.length ? 'has-files' : ''} ${dragActive ? 'drag-active' : ''}`} {...composerDropHandlers}>
        <input ref={composerFileInput} className="visually-hidden" type="file" multiple accept={COMPOSER_FILE_ACCEPT} onChange={(event) => { if (event.target.files) addComposerFiles(event.target.files); event.currentTarget.value = ''; }} />
        {composerAttachments}
        <button className="composer-attach" type="button" aria-label="添加商品资料" title={task ? '当前会话已有商品任务，资料需在任务创建前提供' : '添加图片、表格或文档（可一次选多个，也可以直接拖进输入框）'} disabled={phase === 'processing' || task !== null} onClick={() => composerFileInput.current?.click()}>+</button>
        <textarea rows={1} className="agent-composer-input" value={composer} disabled={phase === 'processing'} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={composerPlaceholder} />
        <button className="send" type="button" onClick={() => void sendMessage()} disabled={(!composer.trim() && pendingFiles.length === 0) || phase === 'processing'}>↑</button>
      </footer>}
    </section>

    {publishOpen && task && passport && <PublishDialog task={task} passport={passport} scenePlan={scenePlan} selectedAssets={selectedAssets} busy={actionBusy} localizationBusy={localizationBusy} localizationError={localizationError} onRetryLocalization={() => setLocalizationRevision((value) => value + 1)} onPublish={publish} onClose={() => setPublishOpen(false)} />}
    {preferencesOpen && <ShopPreferencesDialog initial={preferences} onSaved={(saved) => { setPreferences(saved); setPreferencesOpen(false); }} onClose={() => setPreferencesOpen(false)} />}
    {itemMenu && (() => {
      const menuItem = conversations.find((row) => row.id === itemMenu.id);
      if (!menuItem) return null;
      const openUpward = typeof window !== 'undefined' && window.innerHeight - itemMenu.y < 150;
      return <div className="conversation-menu-layer" role="presentation" onClick={() => setItemMenu(null)} onContextMenu={(event) => { event.preventDefault(); setItemMenu(null); }}>
        <div className="conversation-menu" role="menu" aria-label={`会话操作：${menuItem.title}`} style={openUpward ? { left: Math.max(8, itemMenu.x - 148), bottom: window.innerHeight - itemMenu.y + 6 } : { left: Math.max(8, itemMenu.x - 148), top: itemMenu.y + 6 }} onClick={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => { setRenamingId(menuItem.id); setRenameValue(menuItem.title); setItemMenu(null); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.2V21h3.8L17.8 9.9l-3.7-3.7L3 17.2ZM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7L20.7 7Z"/></svg>重命名</button>
          <button type="button" role="menuitem" disabled={statusBusyId === menuItem.id} onClick={() => { void toggleConversationStatus(menuItem); setItemMenu(null); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg>{menuItem.status === 'COMPLETED' ? '标记为进行中' : '标记为已完成'}</button>
          <button type="button" role="menuitem" className="conversation-menu-danger" onClick={() => { setDeleteCandidate(menuItem); setItemMenu(null); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 11H8L7 9Zm3 2v6h2v-6h-2Zm4 0v6h2v-6h-2Z" /></svg>删除会话</button>
        </div>
      </div>;
    })()}
    {deleteCandidate && <DeleteConversationDialog conversation={deleteCandidate} busy={deleteBusy} onDelete={() => void removeConversation()} onClose={() => setDeleteCandidate(null)} />}
  </main>;
}
