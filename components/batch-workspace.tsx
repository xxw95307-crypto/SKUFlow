'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { groupBatchFolders } from '@/lib/domain/batch-folders';
import type { BatchSummary, BatchItemSummary } from '@/lib/server/batch-store';
import type { PlatformId } from '@/lib/domain/platform';
import { marketOptionsForPlatform } from '@/lib/platforms/market-options';
import { platformRegistry } from '@/lib/platforms/registry';
import './batch-workspace.css';

interface BatchListItem { id: string; name: string; sourceLabel: string; createdAt: string; itemCount: number }
interface Target { platformId: PlatformId; market: string }
const noPreferredTargets: Target[] = [];
interface ReviewDraft {
  id: string; platformId: string; market: string; status: string;
  payload: { fields: Record<string, unknown>; fieldSources: Record<string, string>; confirmedInferredFields?: string[]; schema: { fields: Array<{ key: string; label: string }> } };
  validationIssues: Array<{ severity: string }>;
}
interface ReviewCandidate { item: BatchItemSummary; drafts: ReviewDraft[] }
const supportedPlatforms = platformRegistry.filter((platform) => platform.capabilities.contentGeneration);
const stageLabels: Record<BatchItemSummary['stage'], string> = {
  NEW: '待开始', PROCESSING: '处理中', NEEDS_ATTENTION: '待处理',
  READY_TO_PUBLISH: '可交付', PUBLISHED: '已交付', FAILED: '失败',
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

export function BatchWorkspace({ embedded = false, preferredTargets = noPreferredTargets, onOpenConversation, activeConversationId, conversationSwitchDisabled = false }: { embedded?: boolean; preferredTargets?: Target[]; onOpenConversation?: (id: string) => void; activeConversationId?: string | null; conversationSwitchDisabled?: boolean }) {
  const folderInput = useRef<HTMLInputElement>(null);
  const stopRequested = useRef(false);
  const targetsEdited = useRef(false);
  const [files, setFiles] = useState<File[]>([]);
  const [folderError, setFolderError] = useState('');
  const [batchName, setBatchName] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [batches, setBatches] = useState<BatchListItem[]>([]);
  const [batchesLoaded, setBatchesLoaded] = useState(false);
  const [batch, setBatch] = useState<BatchSummary | null>(null);
  const [view, setView] = useState<'create' | 'detail'>('create');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [reviewCandidates, setReviewCandidates] = useState<ReviewCandidate[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const attachFolderInput = useCallback((input: HTMLInputElement | null) => {
    folderInput.current = input;
    if (input) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
  }, []);

  useEffect(() => {
    if (!targetsEdited.current) setTargets(preferredTargets);
  }, [preferredTargets]);

  const updateBatchUrl = (id?: string) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('id', id);
    else url.searchParams.delete('id');
    window.history.replaceState({}, '', `${url.pathname}${url.search}`);
  };

  useEffect(() => {
    void (async () => {
      try {
        const list = await api<{ batches: BatchListItem[] }>('/api/batches');
        setBatches(list.batches);
        setBatchesLoaded(true);
        const wanted = new URLSearchParams(window.location.search).get('id');
        const id = list.batches.find((item) => item.id === wanted)?.id;
        if (id) {
          setBatch((await api<{ batch: BatchSummary }>(`/api/batches/${id}`)).batch);
          setView('detail');
        }
      } catch (caught) { setError(caught instanceof Error ? caught.message : '批量任务加载失败'); }
    })();
  }, []);

  const refreshBatch = async (id: string) => {
    const next = (await api<{ batch: BatchSummary }>(`/api/batches/${id}`)).batch;
    setBatch(next);
    return next;
  };

  const reportItemError = async (batchId: string, taskId: string, error: string | null) => {
    await api(`/api/batches/${batchId}/items/${taskId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error }),
    });
  };

  const chooseFiles = (selected: FileList | null) => {
    const next = Array.from(selected || []);
    try {
      const grouped = groupBatchFolders(next.map((file, index) => ({ index, name: file.name, relativePath: file.webkitRelativePath, size: file.size })));
      setFiles(next);
      setBatchName(grouped.root);
      setFolderError('');
    } catch (caught) {
      setFiles([]);
      setFolderError(caught instanceof Error ? caught.message : '文件夹格式不正确');
    }
  };

  const togglePlatform = (platformId: PlatformId) => {
    targetsEdited.current = true;
    setTargets((current) => {
      if (current.some((target) => target.platformId === platformId)) {
        return current.filter((target) => target.platformId !== platformId);
      }
      const options = marketOptionsForPlatform(platformId);
      return [...current, { platformId, market: options.includes('美国') ? '美国' : options[0] }];
    });
  };

  const toggleMarket = (platformId: PlatformId, market: string) => {
    targetsEdited.current = true;
    setTargets((current) => current.some((target) => target.platformId === platformId && target.market === market)
      ? current.filter((target) => target.platformId !== platformId || target.market !== market)
      : [...current, { platformId, market }]);
  };

  const toggleAllMarkets = (platformId: PlatformId) => {
    targetsEdited.current = true;
    setTargets((current) => {
      const options = marketOptionsForPlatform(platformId);
      const selected = new Set(current.filter((target) => target.platformId === platformId).map((target) => target.market));
      if (options.every((market) => selected.has(market))) return current.filter((target) => target.platformId !== platformId);
      return [...current, ...options.filter((market) => !selected.has(market)).map((market) => ({ platformId, market }))];
    });
  };

  const createBatch = async () => {
    if (!files.length) return;
    setBusy('creating'); setError('');
    try {
      const form = new FormData();
      form.set('name', batchName);
      form.set('paths', JSON.stringify(files.map((file) => file.webkitRelativePath)));
      form.set('targets', JSON.stringify(targets));
      files.forEach((file) => form.append('files', file, file.name));
      const created = await api<{ id: string; name: string; count: number }>('/api/batches', { method: 'POST', body: form });
      setFiles([]);
      if (folderInput.current) folderInput.current.value = '';
      const list = await api<{ batches: BatchListItem[] }>('/api/batches');
      setBatches(list.batches);
      await refreshBatch(created.id);
      setView('detail');
      updateBatchUrl(created.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '创建失败'); }
    finally { setBusy(''); }
  };

  const processItem = async (current: BatchItemSummary) => {
    const taskId = current.taskId;
    let taskStatus = current.taskStatus;
    const post = <T,>(suffix: string, body: Record<string, unknown> = {}) => api<T>(`/api/tasks/${taskId}/${suffix}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (['CREATED', 'INGESTING', 'FAILED'].includes(taskStatus)) {
      const parsed = await post<{ task: { status: string } }>('parse');
      taskStatus = parsed.task.status as typeof taskStatus;
    }
    if (taskStatus === 'FILES_PARSED') {
      const images = await api<{ files: Array<{ id: string }>; summary: { failed: number } }>(`/api/tasks/${taskId}/analyze-images`);
      if (images.files.length > 0) {
        const analyzed = await post<{ summary: { failed: number } }>('analyze-images');
        if (analyzed.summary.failed > 0) throw new Error(`${analyzed.summary.failed} 张图片理解失败，请打开商品任务检查`);
      }
      await post('extract-facts');
    }
    let passport = (await api<{ passport: { conflicts: Array<{ status: string }>; platformDrafts: Array<{ id: string; status: string }> } }>(`/api/tasks/${taskId}/passport`)).passport;
    if (passport.conflicts.some((conflict) => conflict.status === 'OPEN')) return;
    for (let i = 0; i < passport.platformDrafts.length; i++) {
      if (!passport.platformDrafts.some((draft) => draft.status === 'PLANNED')) break;
      setProgress(`正在为「${current.folder}」准备第 ${i + 1}/${passport.platformDrafts.length} 份站点文案…`);
      await post('compile-drafts');
      passport = (await api<{ passport: typeof passport }>(`/api/tasks/${taskId}/passport`)).passport;
    }
  };

  const processBatch = async (only?: BatchItemSummary) => {
    if (!batch) return;
    setBusy('processing'); setError(''); stopRequested.current = false;
    const items = only ? [only] : batch.items.filter((item) => item.stage === 'NEW' || item.stage === 'PROCESSING' || item.stage === 'FAILED');
    try {
      for (let i = 0; i < items.length; i++) {
        if (stopRequested.current) break;
        const item = items[i];
        setProgress(`正在分析 ${i + 1}/${items.length}：${item.folder}`);
        try {
          await processItem(item);
          await reportItemError(batch.id, item.taskId, null);
          setItemErrors((previous) => { const next = { ...previous }; delete next[item.taskId]; return next; });
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : '分析失败';
          setItemErrors((previous) => ({ ...previous, [item.taskId]: message }));
          await reportItemError(batch.id, item.taskId, message).catch(() => undefined);
        }
        await refreshBatch(batch.id);
      }
    } finally { setBusy(''); setProgress(''); }
  };

  const prepareBulkReview = async () => {
    if (!batch) return;
    setBusy('reviewing'); setError('');
    try {
      const candidates: ReviewCandidate[] = [];
      for (const item of batch.items.filter((entry) => entry.stage === 'NEEDS_ATTENTION' && entry.conflictCount === 0 && entry.draftCount > 0)) {
        const response = await api<{ passport: { platformDrafts: ReviewDraft[] } }>(`/api/tasks/${item.taskId}/passport`);
        const drafts = response.passport.platformDrafts;
        if (!drafts.length || !drafts.every((draft) => {
          if (draft.status !== 'VALIDATED' || !Array.isArray(draft.payload?.schema?.fields)
            || !draft.payload?.fields || !Array.isArray(draft.validationIssues)
            || draft.validationIssues.some((issue) => issue.severity === 'error')) return false;
          const confirmed = new Set(draft.payload.confirmedInferredFields || []);
          return Object.entries(draft.payload.fieldSources || {}).every(([key, source]) => source !== 'AI_INFERRED' || confirmed.has(key));
        })) continue;
        candidates.push({ item, drafts });
      }
      setReviewCandidates(candidates);
      setReviewOpen(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '审核资料加载失败'); }
    finally { setBusy(''); }
  };

  const approveBulkReview = async () => {
    if (!batch || !reviewCandidates.length) return;
    setBusy('approving'); setError('');
    try {
      for (const candidate of reviewCandidates) {
        for (const draft of candidate.drafts) {
          try {
            await api(`/api/tasks/${candidate.item.taskId}/listing-drafts`, {
              method: 'PATCH', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ draftId: draft.id, action: 'approve', fields: draft.payload.fields,
                confirmedInferredFields: draft.payload.confirmedInferredFields || [] }),
            });
          } catch (caught) {
            const message = caught instanceof Error ? caught.message : '审核失败';
            setItemErrors((previous) => ({ ...previous, [candidate.item.taskId]: message }));
            await reportItemError(batch.id, candidate.item.taskId, message).catch(() => undefined);
          }
        }
      }
      await refreshBatch(batch.id);
      setReviewOpen(false); setReviewCandidates([]);
    } finally { setBusy(''); }
  };

  const publishBatch = async (only?: BatchItemSummary) => {
    if (!batch) return;
    setBusy('publishing'); setError(''); stopRequested.current = false;
    const items = only ? [only] : batch.items.filter((item) => item.stage === 'READY_TO_PUBLISH');
    try {
      for (let i = 0; i < items.length; i++) {
        if (stopRequested.current) break;
        const item = items[i];
        setProgress(`正在交付 ${i + 1}/${items.length}：${item.folder}`);
        try {
          const response = await api<{ passport: { platformDrafts: Array<{ id: string; status: string }> } }>(`/api/tasks/${item.taskId}/passport`);
          const approvedDrafts = response.passport.platformDrafts.filter((draft) => draft.status === 'APPROVED');
          for (let j = 0; j < approvedDrafts.length; j++) {
            const draftId = approvedDrafts[j].id;
            setProgress(`正在交付 ${i + 1}/${items.length}：${item.folder} · 站点 ${j + 1}/${approvedDrafts.length}`);
            await api(`/api/tasks/${item.taskId}/localize-drafts`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draftId }),
            });
            await api(`/api/tasks/${item.taskId}/publish-mock`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ draftId, mediaPlanId: item.mediaPlanId, selectedAssetIds: item.selectedAssetIds }),
            });
          }
          await reportItemError(batch.id, item.taskId, null);
          setItemErrors((previous) => { const next = { ...previous }; delete next[item.taskId]; return next; });
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : '交付失败';
          setItemErrors((previous) => ({ ...previous, [item.taskId]: message }));
          await reportItemError(batch.id, item.taskId, message).catch(() => undefined);
        }
        await refreshBatch(batch.id);
      }
    } finally { setBusy(''); setProgress(''); }
  };

  const preview = files.length ? groupBatchFolders(files.map((file, index) => ({ index, name: file.name, relativePath: file.webkitRelativePath, size: file.size }))) : null;
  const counts = batch ? {
    total: batch.items.length,
    attention: batch.items.filter((item) => item.stage === 'NEEDS_ATTENTION').length,
    ready: batch.items.filter((item) => item.stage === 'READY_TO_PUBLISH').length,
    delivered: batch.items.filter((item) => item.stage === 'PUBLISHED').length,
  } : null;

  return <div className={`batch-page${embedded ? ' embedded' : ''}`}>
    {!embedded && <header className="batch-topbar"><Link href="/" className="batch-brand"><span>S</span> SKUFlow</Link><Link href="/">返回 AI 上新</Link></header>}
    <div className="batch-layout">
      <section className="batch-main">
        {view === 'create' ? <div className="batch-heading"><div><span>批量上新</span><h1>创建批量任务</h1><p>每款商品一个文件夹。选好总文件夹和目标站点，就可以开始。</p></div></div> : <div className="batch-detail-toolbar"><button type="button" onClick={() => { setView('create'); updateBatchUrl(); }}>＋ 新建批次</button></div>}
        {batches.length > 0 && <details className="batch-history"><summary>历史批次 <span>{batches.length} 批</span></summary><div>{batches.map((item) => <button type="button" key={item.id} className={view === 'detail' && batch?.id === item.id ? 'selected' : ''} onClick={() => { void refreshBatch(item.id); setView('detail'); updateBatchUrl(item.id); }}><b>{item.name}</b><small>{item.itemCount} 款商品 · {new Date(item.createdAt).toLocaleDateString('zh-CN')}</small></button>)}</div></details>}
        {view === 'create' && <section className="batch-create">
          <div className="batch-create-header"><div><b>创建新批次</b><small>选择包含 2–10 个商品子文件夹的总文件夹</small></div><label className="batch-folder-button">选择总文件夹<input ref={attachFolderInput} type="file" multiple onChange={(event) => chooseFiles(event.target.files)} /></label></div>
          {folderError && <p className="batch-error">{folderError}</p>}
          {preview && <><div className="batch-preview-summary">识别到 <b>{preview.products.length}</b> 款商品、<b>{files.length}</b> 份资料</div>
            <div className="batch-preview-list">{preview.products.map((product) => <span key={product.name}>{product.name} <small>{product.files.length} 个文件</small></span>)}</div>
            <label className="batch-field">批次名称<input value={batchName} maxLength={80} onChange={(event) => setBatchName(event.target.value)} /></label>
            <div className="batch-target-picker"><b>发布目标</b><p>选中平台后会先选一个默认站点；在下方点选更多站点即可。</p>
              <div className="batch-platform-options" role="group" aria-label="选择发布平台">{supportedPlatforms.map((platform) => {
                const selected = targets.some((target) => target.platformId === platform.id);
                return <button key={platform.id} type="button" aria-pressed={selected} onClick={() => togglePlatform(platform.id)}>{platform.name}</button>;
              })}</div>
              <div className="batch-market-groups">{supportedPlatforms.filter((platform) => targets.some((target) => target.platformId === platform.id)).map((platform) => <div className="batch-market-group" key={platform.id}>
                <div className="batch-market-heading"><strong>{platform.name}</strong><span>已选 {targets.filter((target) => target.platformId === platform.id).length} 个站点</span><button type="button" onClick={() => toggleAllMarkets(platform.id)}>{targets.filter((target) => target.platformId === platform.id).length === marketOptionsForPlatform(platform.id).length ? '取消全选' : '全选站点'}</button></div>
                <div className="batch-market-options" role="group" aria-label={`${platform.name} 站点`}>{marketOptionsForPlatform(platform.id).map((market) => {
                  const selected = targets.some((target) => target.platformId === platform.id && target.market === market);
                  return <button key={market} type="button" aria-pressed={selected} onClick={() => toggleMarket(platform.id, market)}>{market}</button>;
                })}</div>
              </div>)}</div>
              <p className="batch-target-count" role="status">已选 {targets.length} 个平台站点组合{targets.length ? `，每款商品 ${targets.length} 份、本批预计 ${preview.products.length * targets.length} 份 Listing` : '，请至少选择一个'}</p>
            </div>
            <button className="batch-primary" type="button" disabled={!!busy || targets.length === 0} onClick={() => void createBatch()}>{busy === 'creating' ? '正在导入…' : '创建批量任务'}</button>
          </>}
        </section>}
        {error && <p className="batch-error">{error}{!batchesLoaded && <button type="button" onClick={() => window.location.reload()}>重新加载</button>}</p>}
        {view === 'detail' && batch && counts && <section className="batch-board"><div className="batch-board-head"><div><h2>{batch.name}</h2><small>{counts.total} 款商品{counts.attention > 0 ? ` · ${counts.attention} 款待处理` : ''}{counts.ready > 0 ? ` · ${counts.ready} 款可交付` : ''}{counts.delivered > 0 ? ` · ${counts.delivered} 款已交付` : ''}</small></div><button type="button" onClick={() => void refreshBatch(batch.id)}>刷新</button></div>
          <details className="batch-target-details"><summary>{batch.targets.length} 个目标站点</summary><p>{batch.targets.map((target) => `${target.platformId} ${target.market}`).join('、')}</p></details>
          <div className="batch-actions">{batch.items.some((item) => ['NEW','PROCESSING','FAILED'].includes(item.stage)) && <button type="button" disabled={!!busy} onClick={() => void processBatch()}>分析未完成商品</button>}{counts.attention > 0 && <button type="button" disabled={!!busy} onClick={() => void prepareBulkReview()}>查看批量审核</button>}{counts.ready > 0 && <button className="batch-primary" type="button" disabled={!!busy} onClick={() => void publishBatch()}>交付已审核商品（{counts.ready}）</button>}{busy && <button type="button" onClick={() => { stopRequested.current = true; }}>当前商品完成后停止</button>}</div>
          {progress && <p className="batch-progress" role="status">{progress}</p>}
          <div className="batch-items">{batch.items.map((item) => <article key={item.taskId} className={`batch-item ${item.stage.toLowerCase()}${activeConversationId === item.conversationId ? ' is-active' : ''}`}><div className="batch-item-info"><span className="batch-folder">{item.folder}</span><h3>{item.productName}</h3><small>{item.reason}</small>{(itemErrors[item.taskId] || item.lastError) && <em>{itemErrors[item.taskId] || item.lastError}</em>}</div><div className="batch-item-side"><span className="batch-badge">{stageLabels[item.stage]}</span>{onOpenConversation ? <button type="button" disabled={conversationSwitchDisabled} onClick={() => onOpenConversation(item.conversationId)}>{activeConversationId === item.conversationId ? '右侧已打开' : '打开商品任务'}</button> : <Link href={`/?conversation=${item.conversationId}`}>打开商品任务</Link>}{['NEW','PROCESSING','FAILED'].includes(item.stage) && <button type="button" disabled={!!busy} onClick={() => void processBatch(item)}>继续分析</button>}{item.stage === 'READY_TO_PUBLISH' && <button type="button" disabled={!!busy} onClick={() => void publishBatch(item)}>交付此商品</button>}</div></article>)}</div>
          {!embedded && <p className="batch-note">批量交付仅处理已逐项审核、完成必要媒体确认的商品。Shopify 创建未公开草稿；Amazon 使用官方静态沙箱；其他平台为本地演示草稿。</p>}
        </section>}
      </section>
    </div>
    {reviewOpen && <div className="batch-review-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setReviewOpen(false); }}><section className="batch-review-dialog" role="dialog" aria-modal="true" aria-label="批量审核 Listing">
      <header><div><span>批量审核</span><h2>{reviewCandidates.length ? `${reviewCandidates.length} 款商品可一起确认` : '没有可批量确认的商品'}</h2></div><button type="button" aria-label="关闭" disabled={!!busy} onClick={() => setReviewOpen(false)}>×</button></header>
      {reviewCandidates.length ? <><p>以下商品没有未决冲突或待确认的 AI 推断字段。请逐项查看平台稿，确认后才能进入交付。</p><div className="batch-review-list">{reviewCandidates.map(({ item, drafts }) => <article key={item.taskId}><h3>{item.productName}</h3>{drafts.map((draft) => <details key={draft.id}><summary>{draft.platformId} · {draft.market} · {draft.payload.schema.fields.length} 个字段</summary><dl>{draft.payload.schema.fields.filter((field) => draft.payload.fields[field.key] !== undefined).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{typeof draft.payload.fields[field.key] === 'string' ? String(draft.payload.fields[field.key]) : JSON.stringify(draft.payload.fields[field.key])}</dd></div>)}</dl></details>)}</article>)}</div><footer><button type="button" disabled={!!busy} onClick={() => setReviewOpen(false)}>稍后再审</button><button className="batch-primary" type="button" disabled={!!busy} onClick={() => void approveBulkReview()}>{busy === 'approving' ? '正在确认…' : `确认这 ${reviewCandidates.length} 款商品`}</button></footer></> : <><p>其他商品有资料冲突、缺失字段或待核实的 AI 推断，请在对应商品任务中处理。</p><footer><button type="button" onClick={() => setReviewOpen(false)}>知道了</button></footer></>}
    </section></div>}
  </div>;
}
