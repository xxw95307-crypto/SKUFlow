'use client';

import { useEffect, useState } from 'react';
import type { ParseSummary } from '@/lib/domain/document-parsing';
import type { AgentRun, FactExtractionSummary } from '@/lib/domain/fact-extraction';
import type { ProductPassport } from '@/lib/domain/product-passport';
import type { TaskSnapshot } from '@/lib/domain/task';
import type { VisionAnalysisSummary } from '@/lib/domain/vision-analysis';

interface ProviderState {
  name: string;
  model: string;
  configured: boolean;
}

interface UnderstandingState {
  parseSummary: ParseSummary | null;
  visionSummary: VisionAnalysisSummary | null;
  provider: ProviderState | null;
  run: AgentRun | null;
}

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || fallback);
  return payload;
}

export function ProductUnderstandingPanel({
  task,
  passport,
  onPassportUpdate,
  onTaskUpdate,
}: {
  task: TaskSnapshot;
  passport: ProductPassport;
  onPassportUpdate: (passport: ProductPassport) => void;
  onTaskUpdate: (task: TaskSnapshot) => void;
}) {
  const [state, setState] = useState<UnderstandingState>({ parseSummary: null, visionSummary: null, provider: null, run: null });
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [lastSummary, setLastSummary] = useState<FactExtractionSummary | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch(`/api/tasks/${task.id}/parse`, { signal: controller.signal }),
      fetch(`/api/tasks/${task.id}/analyze-images`, { signal: controller.signal }),
      fetch(`/api/tasks/${task.id}/extract-facts`, { signal: controller.signal }),
    ]).then(async ([parseResponse, visionResponse, factResponse]) => {
      const [parsePayload, visionPayload, factPayload] = await Promise.all([
        responseJson<{ summary?: ParseSummary }>(parseResponse, '资料读取状态获取失败'),
        responseJson<{ summary?: VisionAnalysisSummary }>(visionResponse, '图片属性状态获取失败'),
        responseJson<{ provider?: ProviderState; run?: AgentRun | null }>(factResponse, '商品属性状态获取失败'),
      ]);
      setState({
        parseSummary: parsePayload.summary ?? null,
        visionSummary: visionPayload.summary ?? null,
        provider: factPayload.provider ?? null,
        run: factPayload.run ?? null,
      });
      setError('');
    }).catch((caught) => {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : '商品资料状态获取失败');
    });
    return () => controller.abort();
  }, [task.id]);

  const buildPassport = async () => {
    setBusy(true);
    setError('');
    setLastSummary(null);
    try {
      let currentTask = task;
      let parseSummary = state.parseSummary;
      if (['CREATED', 'INGESTING', 'FAILED'].includes(currentTask.status)) {
        setPhase('正在读取全部文件…');
        const parsePayload = await responseJson<{ task: TaskSnapshot; summary: ParseSummary }>(
          await fetch(`/api/tasks/${task.id}/parse`, { method: 'POST' }),
          '源文件解析失败',
        );
        currentTask = parsePayload.task;
        parseSummary = parsePayload.summary;
        onTaskUpdate(currentTask);
      }

      let visionSummary = state.visionSummary;
      if ((visionSummary?.totalImages ?? 0) > 0) {
        setPhase('正在从图片提取商品属性…');
        const visionPayload = await responseJson<{ summary: VisionAnalysisSummary }>(
          await fetch(`/api/tasks/${task.id}/analyze-images`, { method: 'POST' }),
          '图片属性提取失败',
        );
        visionSummary = visionPayload.summary;
      }

      setPhase('正在合并属性并检查冲突…');
      const factPayload = await responseJson<{
        task: TaskSnapshot;
        passport: ProductPassport;
        run: AgentRun;
        summary: FactExtractionSummary;
      }>(await fetch(`/api/tasks/${task.id}/extract-facts`, { method: 'POST' }), '统一商品属性生成失败');
      onTaskUpdate(factPayload.task);
      onPassportUpdate(factPayload.passport);
      setLastSummary(factPayload.summary);
      setState({ parseSummary, visionSummary, provider: state.provider, run: factPayload.run });
      setPhase('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '统一商品属性生成失败');
      setPhase('');
    } finally {
      setBusy(false);
    }
  };

  const openConflicts = passport.conflicts.filter((conflict) => conflict.status === 'OPEN').length;
  const missingFacts = passport.facts.filter((fact) => fact.status === 'MISSING').length;
  const completed = state.run?.status === 'COMPLETED';
  const modelReady = state.provider?.configured === true;

  return <section className="product-understanding-panel">
    <div className="understanding-head">
      <div className="understanding-symbol">AI</div>
      <div>
        <span className="tiny-label">ONE PRODUCT · ALL SOURCES</span>
        <h3>统一商品属性生成</h3>
        <p>本任务中的图片、文档和表格均视为同一个商品；系统会统一提取属性，并标出跨资料冲突。</p>
      </div>
      <div className="agent-provider"><i className={modelReady ? 'online' : ''} /><span>阿里云百炼<small>{state.provider?.model ?? '读取配置中'}</small></span></div>
      <button type="button" onClick={buildPassport} disabled={busy || !modelReady}>
        {busy ? phase : completed ? '重新检查全部资料' : '生成统一商品档案'}
      </button>
    </div>

    {!modelReady && state.provider && <div className="understanding-warning">百炼模型尚未配置，暂时不能生成商品属性。</div>}
    {error && <div className="form-error" role="alert">{error}</div>}

    <div className="understanding-steps">
      <article className={state.parseSummary?.completed ? 'done' : ''}><span>1</span><div><b>读取资料</b><small>{state.parseSummary ? `${state.parseSummary.completed}/${state.parseSummary.total} 个文件` : '等待读取'}</small></div></article>
      <article className={!state.visionSummary?.totalImages || state.visionSummary.completed === state.visionSummary.totalImages ? 'done' : ''}><span>2</span><div><b>提取图片属性</b><small>{state.visionSummary?.totalImages ? `${state.visionSummary.completed}/${state.visionSummary.totalImages} 张图片` : '没有图片或等待处理'}</small></div></article>
      <article className={completed ? 'done' : ''}><span>3</span><div><b>合并并检查冲突</b><small>{completed ? '商品档案已生成' : '等待生成'}</small></div></article>
    </div>

    {completed && <div className={`understanding-result ${openConflicts > 0 ? 'has-conflicts' : ''}`}>
      <span>{openConflicts > 0 ? '!' : '✓'}</span>
      <div><b>{openConflicts > 0 ? `发现 ${openConflicts} 项资料冲突，需要确认` : '商品属性已完成合并'}</b><small>{passport.facts.length} 项属性 · {missingFacts} 项待补充{lastSummary ? ` · ${lastSummary.evidenceCreated} 条本次证据` : ''}</small></div>
    </div>}

    <details className="understanding-details">
      <summary>查看处理详情</summary>
      <div>
        <span>文件内容块：{state.parseSummary?.blocks ?? 0}</span>
        <span>图片识别事实：{state.visionSummary?.factsObserved ?? 0}</span>
        <span>模型：{state.provider?.model ?? '未配置'}</span>
        <span>运行状态：{state.run?.status ?? '尚未运行'}</span>
      </div>
    </details>
  </section>;
}
