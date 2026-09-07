'use client';

import { useEffect, useMemo, useState } from 'react';
import { ProductUnderstandingPanel } from '@/components/product-understanding-panel';
import type { EvidenceRecord, ProductFact, ProductPassport } from '@/lib/domain/product-passport';
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

function evidenceSource(fact: ProductFact, evidence: EvidenceRecord[], task: TaskSnapshot): string {
  const record = evidence.find((item) => fact.evidenceIds.includes(item.id));
  if (!record) return fact.status === 'MISSING' ? '未找到可信来源' : fact.sourceKind;
  const filename = task.files.find((file) => file.id === record.fileId)?.name ?? (record.fileId ? '源文件' : '用户输入');
  if (record.locator.kind === 'PAGE') return `${filename} · 第 ${record.locator.page} 页`;
  if (record.locator.kind === 'TABLE_RANGE') return `${filename} · ${record.locator.sheet ?? '工作表'} ${record.locator.range ?? ''}`.trim();
  if (record.locator.kind === 'TEXT_LINES') return `${filename} · 行 ${record.locator.lineStart ?? '?'}-${record.locator.lineEnd ?? '?'}`;
  return filename;
}

function conflictSourceLabel(sourceKind: string | undefined): string {
  if (sourceKind === 'VISION') return '图片识别';
  if (sourceKind === 'FILE_TEXT' || sourceKind === 'OCR') return '文档资料';
  if (sourceKind === 'USER_INPUT') return '商家填写';
  return '资料来源';
}

export function PassportPanel({
  task,
  onBack,
  onNext,
  onTaskChange,
}: {
  task: TaskSnapshot | null;
  onBack: () => void;
  onNext: () => void;
  onTaskChange: (task: TaskSnapshot) => void;
}) {
  const [passport, setPassport] = useState<ProductPassport | null>(null);
  const [resolvingConflict, setResolvingConflict] = useState('');
  const [manualConflictValues, setManualConflictValues] = useState<Record<string, string>>({});
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

  const resolveConflict = async (conflictId: string, candidateId?: string) => {
    if (!task) return;
    const manualValue = manualConflictValues[conflictId]?.trim();
    if (!candidateId && !manualValue) {
      setError('请先填写人工确认值。');
      return;
    }
    setResolvingConflict(conflictId);
    setError('');
    setSaved('');
    try {
      const response = await fetch(`/api/tasks/${task.id}/passport`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conflictResolution: candidateId
            ? { conflictId, candidateId }
            : { conflictId, manualValue },
        }),
      });
      const payload = await response.json() as { passport?: ProductPassport; error?: string };
      if (!response.ok || !payload.passport) throw new Error(payload.error || '冲突确认失败');
      setPassport(payload.passport);
      setManualConflictValues((current) => {
        const next = { ...current };
        delete next[conflictId];
        return next;
      });
      setSaved(`冲突已确认并写入商品档案 v${payload.passport.version}。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '冲突确认失败');
    } finally {
      setResolvingConflict('');
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

  const visibleFacts = passport.facts.filter((fact) => fact.status !== 'MISSING');
  const confirmedCount = visibleFacts.filter((fact) => fact.status === 'CONFIRMED').length;
  const openConflictCount = passport.conflicts.filter((conflict) => conflict.status === 'OPEN').length;

  return <section className="panel facts-panel">
    <div className="section-heading">
      <div><span>PRODUCT PASSPORT</span><h2>统一商品档案</h2><p>所有资料都属于同一个商品。系统开放式提取资料中实际出现的属性，并把图文冲突交给你确认。</p></div>
      <div className="passport-version"><b>v{passport.version}</b><small>{passport.status === 'OPEN' ? '可编辑' : passport.status}</small></div>
    </div>

    <ProductUnderstandingPanel task={task} passport={passport} onPassportUpdate={setPassport} onTaskUpdate={onTaskChange} />

    <div className="passport-metrics">
      <article><b>{visibleFacts.length}</b><span>已识别属性</span></article>
      <article className={openConflictCount > 0 ? 'warn' : ''}><b>{openConflictCount}</b><span>待确认冲突</span></article>
      <article><b>{passport.evidence.length}</b><span>可追溯证据</span></article>
      <article><b>{task.files.length}</b><span>商品资料</span></article>
    </div>

    {openConflictCount > 0 && <div className="merchant-conflict-list">
      <div className="merchant-conflict-title"><span>!</span><div><b>发现图片与文档中的属性不一致</b><p>系统没有替你选择结果，请根据原始资料确认后再生成平台内容。</p></div></div>
      {passport.conflicts.filter((conflict) => conflict.status === 'OPEN').map((conflict) => <article key={conflict.id}>
        <h3>{passport.facts.find((fact) => fact.key === conflict.factKey)?.label ?? conflict.factKey}</h3>
        <div>{conflict.candidates.map((candidate) => <button className="conflict-candidate" type="button" key={candidate.id} disabled={resolvingConflict === conflict.id} onClick={() => resolveConflict(conflict.id, candidate.id)}>
          <small>{conflictSourceLabel(candidate.sourceKind)}</small>
          <b>{displayFactValue(candidate.value, candidate.unit ?? null)}</b>
          <em>{candidate.sourceLabel}</em>
          <strong>采用此值</strong>
        </button>)}</div>
        <div className="conflict-manual">
          <input
            value={manualConflictValues[conflict.id] ?? ''}
            placeholder="或输入人工核实后的值"
            maxLength={240}
            onChange={(event) => setManualConflictValues((current) => ({ ...current, [conflict.id]: event.target.value }))}
          />
          <button type="button" disabled={resolvingConflict === conflict.id} onClick={() => resolveConflict(conflict.id)}>
            {resolvingConflict === conflict.id ? '确认中…' : '采用人工值'}
          </button>
        </div>
      </article>)}
    </div>}

    <div className="passport-identity">
      <div><span className="tiny-label">当前商品 · 模型综合命名</span><h3>{task.productName}</h3><p>{TASK_STATUS_LABELS[task.status]} · 商品档案 v{passport.version}</p></div>
      <p className="passport-open-note">这里不预设榨汁机、服装或其他类目的通用必填项；平台真正需要但资料中没有的字段，会在下一步由 Listing Agent 补写并标记。</p>
    </div>

    {error && <div className="form-error" role="alert">{error}</div>}
    {saved && <div className="form-success" role="status">✓ {saved}</div>}

    <div className="fact-table">
      <div className="fact-head"><span>商品属性</span><span>当前值</span><span>来自哪份资料</span><span>状态</span></div>
      {visibleFacts.map((fact) => <div className="fact-row" key={fact.id}>
        <b>{fact.label}</b>
        <span>{displayFactValue(fact.value, fact.unit)}</span>
        <span className="source-link">{evidenceSource(fact, passport.evidence, task)}</span>
        <span><i className={`status-dot ${fact.status.toLowerCase()}`} />{factStatusLabels[fact.status]}</span>
      </div>)}
    </div>

    <details className="passport-advanced">
      <summary>查看平台适配与技术详情</summary>
      <div className="passport-structure-grid">
        <article><span className="tiny-label">证据记录</span><h3>{passport.evidence.length} 条可追溯证据</h3><p>每个属性都保留对应文件、页码、表格范围或图片区域，供需要时核查。</p></article>
        <article><span className="tiny-label">平台草稿</span><h3>平台草稿矩阵</h3><div className="draft-chip-list">{passport.platformDrafts.map((draft) => <span key={draft.id}><b>{platformNames.get(draft.platformId) ?? draft.platformId}</b>{draft.market} · {draftStatusLabels[draft.status]}</span>)}</div></article>
      </div>
    </details>

    <div className="footer-actions">
      <span>{visibleFacts.length} 项开放属性 · {confirmedCount} 项人工确认 · 数据版本 v{passport.version}</span>
      <button className="primary" type="button" onClick={onNext}>查看平台内容预览 →</button>
    </div>
  </section>;
}
