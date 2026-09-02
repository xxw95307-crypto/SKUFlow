'use client';

import { useEffect, useMemo, useState } from 'react';
import { ParseResultsPanel } from '@/components/parse-results-panel';
import type { ProductPassport } from '@/lib/domain/product-passport';
import { TASK_STATUS_LABELS, type TaskSnapshot } from '@/lib/domain/task';
import { platformRegistry } from '@/lib/platforms/registry';

const factStatusLabels = {
  CONFIRMED: '已确认',
  EXTRACTED: '已提取',
  CONFLICT: '存在冲突',
  MISSING: '待补充',
} as const;

const draftStatusLabels = {
  PLANNED: '已规划',
  GENERATING: '生成中',
  NEEDS_REVIEW: '待审核',
  VALIDATED: '已校验',
  APPROVED: '已批准',
  EXPORTED: '已导出',
  DRAFT_CREATED: '已建草稿',
  FAILED: '失败',
} as const;

function displayFactValue(value: unknown, unit: string | null): string {
  if (value === null || value === '') return '待补充';
  const rendered = typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : JSON.stringify(value);
  return unit ? `${rendered} ${unit}` : rendered;
}

export function PassportPanel({
  task,
  onBack,
  onNext,
}: {
  task: TaskSnapshot | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const [passport, setPassport] = useState<ProductPassport | null>(null);
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    if (!task) return;
    const controller = new AbortController();
    fetch(`/api/tasks/${task.id}/passport`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { passport?: ProductPassport; error?: string };
        if (!response.ok || !payload.passport) throw new Error(payload.error || '商品护照加载失败');
        setError('');
        setPassport(payload.passport);
        setBrand(String(payload.passport.facts.find((fact) => fact.key === 'product.brand')?.value ?? ''));
        setCategory(String(payload.passport.facts.find((fact) => fact.key === 'product.category_hint')?.value ?? ''));
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : '商品护照加载失败');
      });
    return () => controller.abort();
  }, [task]);

  const platformNames = useMemo(
    () => new Map(platformRegistry.map((platform) => [platform.id, platform.shortName])),
    [],
  );

  const saveFacts = async () => {
    if (!task) return;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const response = await fetch(`/api/tasks/${task.id}/passport`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          facts: [
            { key: 'product.brand', label: '品牌', value: brand.trim() || null },
            { key: 'product.category_hint', label: '候选类目', value: category.trim() || null },
          ],
        }),
      });
      const payload = await response.json() as { passport?: ProductPassport; error?: string };
      if (!response.ok || !payload.passport) throw new Error(payload.error || '商品事实保存失败');
      setPassport(payload.passport);
      setSaved(`已保存为护照 v${payload.passport.version}，并生成表单证据记录。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '商品事实保存失败');
    } finally {
      setBusy(false);
    }
  };

  if (!task) {
    return <section className="panel facts-panel passport-empty">
      <span>DAY 02 · PRODUCT PASSPORT</span>
      <h2>还没有可读取的商品任务</h2>
      <p>先上传一份商品资料并创建任务，系统会同时初始化商品、证据、冲突和平台草稿结构。</p>
      <button className="primary" type="button" onClick={onBack}>返回创建任务</button>
    </section>;
  }

  if (!passport || passport.taskId !== task.id) {
    return <section className="panel facts-panel passport-empty">
      <span>DAY 02 · PRODUCT PASSPORT</span>
      <h2>{error ? '商品护照暂不可用' : '正在读取商品护照…'}</h2>
      <p>{error || `任务 ${task.id} 的数据正在初始化。`}</p>
      <button className="ghost" type="button" onClick={onBack}>返回任务页</button>
    </section>;
  }

  const confirmedCount = passport.facts.filter((fact) => fact.status === 'CONFIRMED').length;
  const missingCount = passport.facts.filter((fact) => fact.status === 'MISSING').length;
  const openConflictCount = passport.conflicts.filter((conflict) => conflict.status === 'OPEN').length;

  return <section className="panel facts-panel">
    <div className="section-heading">
      <div><span>DAY 03 · PARSING WORKSPACE</span><h2>统一解析与商品护照</h2><p>先检查文件解析结果，再由 Day 4 Agent 将内容块转成可追溯事实。</p></div>
      <div className="passport-version"><b>v{passport.version}</b><small>{passport.status === 'OPEN' ? '可编辑' : passport.status}</small></div>
    </div>

    <ParseResultsPanel task={task} />

    <div className="passport-metrics">
      <article><b>{passport.facts.length}</b><span>商品事实</span></article>
      <article><b>{passport.evidence.length}</b><span>证据记录</span></article>
      <article><b>{openConflictCount}</b><span>开放冲突</span></article>
      <article><b>{passport.platformDrafts.length}</b><span>平台草稿</span></article>
    </div>

    <div className="passport-identity">
      <div><span className="tiny-label">CURRENT TASK</span><h3>{task.productName}</h3><p>{task.id} · {TASK_STATUS_LABELS[task.status]} · 护照状态 {passport.status}</p></div>
      <div className="passport-editors">
        <label><span>品牌</span><input value={brand} maxLength={120} placeholder="例如 BlendGo" onChange={(event) => setBrand(event.target.value)} /></label>
        <label><span>候选类目</span><input value={category} maxLength={120} placeholder="例如 便携式搅拌机" onChange={(event) => setCategory(event.target.value)} /></label>
        <button type="button" onClick={saveFacts} disabled={busy}>{busy ? '保存中…' : '保存基础事实'}</button>
      </div>
    </div>

    {error && <div className="form-error" role="alert">{error}</div>}
    {saved && <div className="form-success" role="status">✓ {saved}</div>}

    <div className="fact-table">
      <div className="fact-head"><span>字段</span><span>当前值</span><span>证据</span><span>状态</span></div>
      {passport.facts.map((fact) => <div className="fact-row" key={fact.id}>
        <b>{fact.label}<small>{fact.key}</small></b>
        <span>{displayFactValue(fact.value, fact.unit)}</span>
        <span className="source-link">{fact.evidenceIds.length} 条 · {fact.sourceKind}</span>
        <span><i className={`status-dot ${fact.status.toLowerCase()}`} />{factStatusLabels[fact.status]}</span>
      </div>)}
    </div>

    <div className="passport-structure-grid">
      <article><span className="tiny-label">CONFLICT LEDGER</span><h3>冲突账本</h3>{openConflictCount === 0 ? <p>当前没有开放冲突。Day 3 解析器产生不一致值时，将在这里保留候选值与证据。</p> : <p>{openConflictCount} 项冲突等待人工裁决。</p>}</article>
      <article><span className="tiny-label">PLATFORM DRAFTS</span><h3>平台草稿矩阵</h3><div className="draft-chip-list">{passport.platformDrafts.map((draft) => <span key={draft.id}><b>{platformNames.get(draft.platformId) ?? draft.platformId}</b>{draft.market} · {draftStatusLabels[draft.status]}</span>)}</div></article>
    </div>

    <div className="footer-actions">
      <span>{confirmedCount} 项已确认 · {missingCount} 项待补充 · 数据版本 v{passport.version}</span>
      <button className="primary" type="button" onClick={onNext}>查看 Day 3 平台版本预览 →</button>
    </div>
  </section>;
}
