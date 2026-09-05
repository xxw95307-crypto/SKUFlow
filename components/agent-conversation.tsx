'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ListingWorkspace } from '@/components/listing-workspace';
import { TaskIntake } from '@/components/task-intake';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import type { FactConflict, FactValue, ProductPassport } from '@/lib/domain/product-passport';
import { PENDING_PRODUCT_NAME, TASK_STATUS_LABELS, type TaskSnapshot } from '@/lib/domain/task';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import { platformRegistry } from '@/lib/platforms/registry';

type AgentPhase = 'loading' | 'intake' | 'resume' | 'processing' | 'conflict' | 'listing' | 'assets' | 'publish' | 'complete' | 'error';

interface ChatMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
  meta?: string;
}

const assetCandidates = [
  { id: 'main-square', type: '主图 · 1:1', title: '平台白底主图', note: '适用于商品列表和搜索入口' },
  { id: 'lifestyle', type: '场景图 · 4:5', title: '生活方式场景', note: '用于表达使用情境和商品氛围' },
  { id: 'infographic', type: '信息图 · 1:1', title: '核心卖点信息图', note: '只展示已确认的商品事实' },
  { id: 'detail', type: '细节图 · 3:4', title: '结构与材质细节', note: '放大展示外观、工艺或部件' },
];

const initialMessages: ChatMessage[] = [{
  id: 'welcome',
  role: 'agent',
  text: '你好，我是 SKUFlow 上新 Agent。把同一商品的图片、参数表和说明书交给我，我会自动理解商品、生成各平台 Listing，只在必须由你决定时暂停。',
  meta: '上新任务已就绪',
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
  const threadEnd = useRef<HTMLDivElement>(null);

  const platformNames = useMemo(() => new Map(platformRegistry.map((item) => [item.id, item.shortName])), []);
  const currentStep = phase === 'conflict' ? 1 : phase === 'listing' ? 2 : phase === 'assets' ? 3 : phase === 'publish' || phase === 'complete' ? 4 : phase === 'processing' ? progressStep : 0;

  const append = (role: ChatMessage['role'], text: string, meta?: string) => {
    setMessages((current) => [...current, { id: messageId(), role, text, meta }]);
  };

  const fetchPassport = async (taskId: string): Promise<ProductPassport> => {
    const payload = await responseJson<{ passport: ProductPassport }>(await fetch(`/api/tasks/${taskId}/passport`), '商品档案读取失败');
    return payload.passport;
  };

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/tasks', { signal: controller.signal }).then((response) => responseJson<{ tasks: TaskSnapshot[] }>(response, '任务读取失败')).then(async (payload) => {
      const recent = payload.tasks[0];
      if (!recent) { setPhase('intake'); return; }
      const recentPassport = await fetchPassport(recent.id);
      setTask(recent);
      setPassport(recentPassport);
      setPhase('resume');
      setMessages((current) => [...current, {
        id: messageId(), role: 'agent',
        text: `我找到了最近的商品任务“${recent.productName}”。你可以继续它，也可以开始一次新的上新对话。`,
        meta: TASK_STATUS_LABELS[recent.status],
      }]);
    }).catch((caught) => {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : '任务读取失败');
      setPhase('intake');
    });
    return () => controller.abort();
  }, []);

  useEffect(() => { threadEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, phase, busyLabel]);

  const compileListings = async (currentTask: TaskSnapshot) => {
    setPhase('processing');
    setProgressStep(2);
    setBusyLabel('正在读取各平台字段，并生成中文审校稿…');
    setError('');
    try {
      const payload = await responseJson<{ passport: ProductPassport }>(await fetch(`/api/tasks/${currentTask.id}/compile-drafts`, { method: 'POST' }), '多平台 Listing 生成失败');
      setPassport(payload.passport);
      setPhase('listing');
      append('agent', `我已经按平台生成 ${payload.passport.platformDrafts.length} 份中文 Listing 审校稿。请集中审核一次，需要你提供的 SKU、价格和库存也会在这里统一询问。`, '平台稿已就绪');
      setListingOpen(true);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '多平台 Listing 生成失败';
      setError(message); setPhase('error'); append('agent', `我在生成平台稿时遇到了问题：${message}`, '任务已暂停');
    }
  };

  const continueFromPassport = async (currentTask: TaskSnapshot, currentPassport: ProductPassport) => {
    setPassport(currentPassport);
    const openConflicts = currentPassport.conflicts.filter((item) => item.status === 'OPEN');
    if (openConflicts.length > 0) {
      setPhase('conflict');
      append('agent', `商品资料已理解完成，共提取 ${currentPassport.facts.filter((fact) => fact.status !== 'MISSING').length} 项属性。我发现 ${openConflicts.length} 处图文冲突，需要你决定后才能继续。`, '等待人工决策');
      setConflictOpen(true);
      return;
    }
    append('agent', `商品理解已完成，${currentPassport.facts.filter((fact) => fact.status !== 'MISSING').length} 项属性已合并，没有需要你处理的冲突。`, '已自动继续');
    await compileListings(currentTask);
  };

  const handleIntakeComplete = async (createdTask: TaskSnapshot) => {
    setTask(createdTask);
    setPhase('processing');
    setProgressStep(1);
    setBusyLabel('正在整理商品档案…');
    append('user', `已提交 ${createdTask.files.length} 份商品资料，目标平台：${createdTask.platforms.map((id) => platformNames.get(id) ?? id).join('、')}。`);
    try {
      const currentPassport = await fetchPassport(createdTask.id);
      await continueFromPassport(createdTask, currentPassport);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '商品档案读取失败';
      setError(message); setPhase('error');
    }
  };

  const resumeTask = async () => {
    if (!task || !passport) return;
    append('user', `继续任务：${task.productName}`);
    const openConflicts = passport.conflicts.filter((item) => item.status === 'OPEN');
    if (openConflicts.length > 0) { setPhase('conflict'); setConflictOpen(true); return; }
    const generated = passport.platformDrafts.filter((draft) => isListingDraftPayload(draft.payload));
    const published = passport.platformDrafts.filter((draft) => draft.status === 'DRAFT_CREATED');
    const approved = passport.platformDrafts.filter((draft) => draft.status === 'APPROVED');
    if (published.length > 0) { setPhase('complete'); return; }
    if (approved.length === passport.platformDrafts.length && approved.length > 0) { setPhase('assets'); setAssetOpen(true); return; }
    if (generated.length > 0) { setPhase('listing'); setListingOpen(true); return; }
    if (passport.facts.some((fact) => fact.status !== 'MISSING')) { await compileListings(task); return; }
    setPhase('intake');
    append('agent', '这个历史任务还没有形成商品档案。请新建任务并重新上传原始资料。');
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
        append('agent', '所有冲突都已确认。我会继续获取平台字段并生成 Listing，你不需要手动跳转。', '流程继续运行');
        await compileListings(task);
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
    setPhase('assets');
    append('agent', '所有平台 Listing 都已确认。我已经根据实物图和商品卖点准备了视觉候选，请选择要交付的版本。', '等待选图');
    setAssetOpen(true);
  };

  const confirmAssets = () => {
    setAssetOpen(false); setPhase('publish');
    append('user', `已选择 ${selectedAssets.length} 个视觉方案。`);
    append('agent', '上架包已准备完成。这是最后一个必须由你确认的节点：请检查平台、市场和交付范围后再发布。', '等待最终确认');
    setPublishOpen(true);
  };

  const publish = async () => {
    if (!task) return;
    setActionBusy(true); setError('');
    try {
      const payload = await responseJson<{ passport: ProductPassport; message?: string }>(await fetch(`/api/tasks/${task.id}/publish-mock`, { method: 'POST' }), 'Mock 草稿创建失败');
      setPassport(payload.passport); setPublishOpen(false); setPhase('complete');
      append('user', '确认发布。');
      append('agent', `交付完成。${payload.message ?? '已为确认的平台创建 Mock 草稿。'}`, '任务完成');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Mock 草稿创建失败'); }
    finally { setActionBusy(false); }
  };

  const newConversation = () => {
    setTask(null); setPassport(null); setPhase('intake'); setProgressStep(0); setMessages(initialMessages); setError(''); setComposer(''); setSelectedAssets([]);
    setConflictOpen(false); setListingOpen(false); setAssetOpen(false); setPublishOpen(false);
  };

  const sendMessage = async () => {
    const text = composer.trim();
    if (!text) return;
    setComposer(''); append('user', text);
    if (/新建|重新开始/.test(text)) { newConversation(); return; }
    if (phase === 'resume') { await resumeTask(); return; }
    if (phase === 'conflict') { setConflictOpen(true); append('agent', '我已重新打开冲突确认卡片。'); return; }
    if (phase === 'listing' && task) {
      if (/重新生成|再生成/.test(text)) await compileListings(task);
      else setListingOpen(true);
      return;
    }
    if (phase === 'assets') { setAssetOpen(true); return; }
    if (phase === 'publish') { setPublishOpen(true); return; }
    if (phase === 'complete') { append('agent', '这个商品的 Mock 交付已完成。如果要处理下一个商品，可以说“新建任务”。'); return; }
    append('agent', '请在上方上传同一商品的全部资料并选择目标平台。提交后，我会自动开始处理。');
  };

  const visibleFacts = passport?.facts.filter((fact) => fact.status !== 'MISSING') ?? [];
  const openConflictCount = passport?.conflicts.filter((conflict) => conflict.status === 'OPEN').length ?? 0;
  const approvedCount = passport?.platformDrafts.filter((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED').length ?? 0;
  const publishedCount = passport?.platformDrafts.filter((draft) => draft.status === 'DRAFT_CREATED').length ?? 0;

  return <main className="agent-shell">
    <aside className="agent-rail">
      <div className="agent-brand"><span>S</span><div><b>SKUFlow</b><small>Agentic Commerce</small></div></div>
      <button className="new-agent-task" type="button" onClick={newConversation}><span>+</span>新建上新对话</button>
      <div className="agent-rail-label">当前对话</div>
      <button className="conversation-item active" type="button"><span>◉</span><div><b>{task && task.productName !== PENDING_PRODUCT_NAME ? task.productName : '新商品上新'}</b><small>{task ? TASK_STATUS_LABELS[task.status] : '等待资料'}</small></div></button>
      <div className="agent-rail-note"><i /> <b>Agent 自动推进</b><p>只在事实冲突、主观选择和最终发布时向你提问。</p></div>
      <div className="agent-user"><span>林</span><div><b>林晓雨</b><small>品牌运营</small></div></div>
    </aside>

    <section className="agent-main">
      <header className="agent-topbar"><div><span className="agent-online"><i /> SKUFlow Agent 在线</span><h1>{task && task.productName !== PENDING_PRODUCT_NAME ? task.productName : '创建商品上新任务'}</h1></div><div className="agent-model"><span>阿里云百炼</span><b>qwen3.8-max</b></div></header>

      <div className="agent-chat-layout">
        <section className="agent-thread" aria-label="Agent 对话">
          <div className="agent-date">今天 · Agent 工作区</div>
          {messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}>
            <span className="chat-avatar">{message.role === 'agent' ? 'AI' : '林'}</span>
            <div><p>{message.text}</p>{message.meta && <small>{message.meta}</small>}</div>
          </article>)}

          {phase === 'loading' && <div className="agent-running-card"><span className="agent-spinner" /><div><b>{busyLabel}</b><small>我会根据任务状态继续上次的工作。</small></div></div>}

          {phase === 'intake' && <div className="chat-action-card intake"><div className="action-card-head"><span>你只需要提供这些</span><b>目标市场、平台和原始资料</b><p>商品名称、属性、标题和卖点都由 Agent 后续自动生成。</p></div><div className="embedded-intake"><TaskIntake onNext={handleIntakeComplete} /></div></div>}

          {phase === 'resume' && task && <div className="chat-action-card resume"><div className="resume-symbol">↻</div><div><span>可继续的任务</span><h3>{task.productName}</h3><p>{task.platforms.map((id) => platformNames.get(id) ?? id).join('、')} · {task.markets.join('、')}</p></div><div className="resume-actions"><button className="ghost" type="button" onClick={newConversation}>新建任务</button><button className="primary" type="button" onClick={resumeTask}>继续处理 →</button></div></div>}

          {phase === 'processing' && <div className="agent-running-card"><span className="agent-spinner" /><div><b>{busyLabel}</b><small>Agent 正在调用商品理解和平台适配工具，完成后会主动通知你。</small></div><em>自动执行中</em></div>}

          {phase === 'conflict' && passport && <div className="chat-action-card checkpoint warning"><div className="checkpoint-icon">!</div><div><span>流程已暂停</span><h3>{openConflictCount} 项属性冲突需要你确认</h3><p>这些决定会同步影响各平台 Listing，Agent 不会自作主张。</p></div><button type="button" onClick={() => setConflictOpen(true)}>打开确认卡</button></div>}

          {phase === 'listing' && passport && <div className="chat-action-card listing-summary"><div className="action-card-head"><span>LISTING CHECKPOINT</span><b>各平台中文审校稿</b><p>Agent 已按平台字段分别填写。默认只看结果，需要时再展开字段详情。</p></div><div className="platform-review-list">{passport.platformDrafts.map((draft) => {
            const payload = isListingDraftPayload(draft.payload) ? draft.payload : null;
            return <article key={draft.id}><span>{platformNames.get(draft.platformId) ?? draft.platformId}</span><div><b>{payload ? listingTitle(payload) : '等待生成'}</b><small>{draft.market} · {draft.validationIssues.length ? `${draft.validationIssues.length} 项待处理` : '校验通过'}</small></div><em className={draft.status === 'APPROVED' ? 'done' : ''}>{draft.status === 'APPROVED' ? '已确认' : '待审核'}</em></article>;
          })}</div><button className="primary card-primary" type="button" onClick={() => setListingOpen(true)}>审核 {passport.platformDrafts.length} 个平台稿 →</button></div>}

          {phase === 'assets' && <div className="chat-action-card checkpoint success"><div className="checkpoint-icon">▣</div><div><span>视觉素材已准备</span><h3>{selectedAssets.length ? `已选择 ${selectedAssets.length} 个方案` : '请选择要交付的图片'}</h3><p>候选图会与已确认的商品事实和 Listing 保持一致。</p></div><button type="button" onClick={() => setAssetOpen(true)}>打开选图卡</button></div>}

          {phase === 'publish' && <div className="chat-action-card checkpoint final"><div className="checkpoint-icon">↗</div><div><span>最终人工门禁</span><h3>上架包已准备完成</h3><p>只有你明确确认后，Agent 才会调用发布工具。</p></div><button type="button" onClick={() => setPublishOpen(true)}>查看并确认发布</button></div>}

          {phase === 'complete' && <div className="chat-action-card completed"><span>✓</span><div><small>交付完成</small><h3>{publishedCount} 个平台草稿已创建</h3><p>任务、商品事实、人工决策和发布结果均已保留追溯信息。</p></div><button className="primary" type="button" onClick={newConversation}>处理下一个商品</button></div>}

          {error && <div className="chat-error" role="alert"><b>任务暂停</b><span>{error}</span>{task && <button type="button" onClick={resumeTask}>重试当前步骤</button>}</div>}
          <div ref={threadEnd} />
        </section>

        <aside className="agent-context">
          <div className="context-head"><span>任务进度</span><b>{phase === 'complete' ? '已完成' : '进行中'}</b></div>
          <ol className="agent-progress">{['接收资料', '商品理解', 'Listing 审核', '视觉选择', '发布交付'].map((label, index) => <li className={index < currentStep || phase === 'complete' ? 'done' : index === currentStep ? 'current' : ''} key={label}><span>{index < currentStep || phase === 'complete' ? '✓' : index + 1}</span><div><b>{label}</b><small>{index < currentStep || phase === 'complete' ? '已完成' : index === currentStep ? '当前阶段' : '由 Agent 继续'}</small></div></li>)}</ol>
          {task && <div className="context-summary"><span>当前商品</span><h3>{task.productName}</h3><div><b>{visibleFacts.length}</b><small>属性</small><b>{openConflictCount}</b><small>冲突</small><b>{approvedCount}</b><small>已审核</small></div><p>{task.platforms.map((id) => platformNames.get(id) ?? id).join(' · ')}</p></div>}
          {passport && <details className="agent-evidence"><summary>查看商品事实与证据</summary><div>{visibleFacts.slice(0, 12).map((fact) => <p key={fact.id}><b>{fact.label}</b><span>{displayValue(fact.value, fact.unit)}</span></p>)}{visibleFacts.length > 12 && <small>还有 {visibleFacts.length - 12} 项属性已收起</small>}</div></details>}
          <div className="context-safety"><span>◈</span><div><b>人工门禁已开启</b><small>冲突与发布永远需要你确认</small></div></div>
        </aside>
      </div>

      <footer className="agent-composer"><button type="button" aria-label="添加附件" onClick={() => phase !== 'intake' && newConversation()}>+</button><input value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void sendMessage(); }} placeholder={phase === 'intake' ? '可以先告诉 Agent 你想做什么…' : '输入“继续”、“重新生成”或说明你的要求…'} /><button className="send" type="button" onClick={() => void sendMessage()} disabled={!composer.trim()}>↑</button></footer>
    </section>

    {conflictOpen && passport && <ConflictDialog passport={passport} busy={actionBusy} manualValue={manualConflictValue} onManualValue={setManualConflictValue} onResolve={resolveConflict} onClose={() => setConflictOpen(false)} />}
    {listingOpen && task && <AgentDialog eyebrow="AGENT CHECKPOINT · LISTING REVIEW" title="审核各平台中文 Listing" onClose={() => { setListingOpen(false); void refreshAfterListing(); }} wide><div className="embedded-listing"><ListingWorkspace task={task} onAssets={proceedToAssets} /></div></AgentDialog>}
    {assetOpen && <AssetDialog selected={selectedAssets} onToggle={(id) => setSelectedAssets((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} onConfirm={confirmAssets} onClose={() => setAssetOpen(false)} />}
    {publishOpen && task && passport && <PublishDialog task={task} passport={passport} selectedAssets={selectedAssets} busy={actionBusy} onPublish={publish} onClose={() => setPublishOpen(false)} />}
  </main>;
}
