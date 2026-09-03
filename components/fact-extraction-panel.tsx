'use client';

import { useEffect, useState } from 'react';
import type { AgentRun, FactExtractionSummary } from '@/lib/domain/fact-extraction';
import type { ProductPassport } from '@/lib/domain/product-passport';
import type { TaskSnapshot } from '@/lib/domain/task';

interface ProviderState {
  name: string;
  model: string;
  configured: boolean;
  visionSupported: boolean;
}

export function FactExtractionPanel({
  task,
  onPassportUpdate,
  onTaskUpdate,
}: {
  task: TaskSnapshot;
  onPassportUpdate: (passport: ProductPassport) => void;
  onTaskUpdate: (task: TaskSnapshot) => void;
}) {
  const [provider, setProvider] = useState<ProviderState | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [summary, setSummary] = useState<FactExtractionSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/tasks/${task.id}/extract-facts`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { provider?: ProviderState; run?: AgentRun | null; error?: string };
        if (!response.ok || !payload.provider) throw new Error(payload.error || '事实 Agent 状态读取失败');
        setProvider(payload.provider);
        setRun(payload.run ?? null);
        setError('');
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : '事实 Agent 状态读取失败');
      });
    return () => controller.abort();
  }, [task.id]);

  const extractFacts = async () => {
    setBusy(true);
    setError('');
    setSummary(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}/extract-facts`, { method: 'POST' });
      const payload = await response.json() as {
        task?: TaskSnapshot;
        passport?: ProductPassport;
        run?: AgentRun;
        summary?: FactExtractionSummary;
        error?: string;
      };
      if (!response.ok || !payload.task || !payload.passport || !payload.run || !payload.summary) {
        throw new Error(payload.error || '百炼事实抽取失败');
      }
      setRun(payload.run);
      setSummary(payload.summary);
      onPassportUpdate(payload.passport);
      onTaskUpdate(payload.task);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '百炼事实抽取失败');
    } finally {
      setBusy(false);
    }
  };

  return <section className="agent-extraction-panel">
    <div className="agent-extraction-head">
      <div className="agent-symbol">AI</div>
      <div><span className="tiny-label">DAY 04 · FACT EXTRACTION AGENT</span><h3>百炼商品事实 Agent</h3><p>从 Day 3 内容块抽取事实，并回写来源、置信度、冲突与缺失状态。</p></div>
      <div className="agent-provider"><i className={provider?.configured ? 'online' : ''} /><span>{provider?.name ?? '阿里云百炼'}<small>{provider?.model ?? '读取配置中'}</small></span></div>
      <button type="button" onClick={extractFacts} disabled={busy || !provider?.configured}>{busy ? 'Agent 正在推理…' : '启动事实抽取'}</button>
    </div>

    {!provider?.visionSupported && <div className="agent-capability-note"><b>视觉链路待配置</b><span>PDF/Excel/TXT 可直接抽取；纯图片任务需要先配置并运行上方视觉 Agent。</span></div>}
    {provider?.visionSupported && <div className="agent-capability-note ready"><b>Agent 间交接已启用</b><span>事实 Agent 会合并文档内容块与已完成的 VISION 证据，纯图片任务也可继续抽取。</span></div>}
    {!provider?.configured && provider && <div className="form-error">百炼运行时密钥尚未配置，事实抽取按钮已停用。</div>}
    {error && <div className="form-error" role="alert">{error}</div>}

    {summary ? <div className="agent-summary-grid">
      <article><b>{summary.factsExtracted}</b><span>提取事实</span></article>
      <article><b>{summary.evidenceCreated}</b><span>新增证据</span></article>
      <article className={summary.conflicts > 0 ? 'warn' : ''}><b>{summary.conflicts}</b><span>检测冲突</span></article>
      <article className={summary.missing > 0 ? 'muted' : ''}><b>{summary.missing}</b><span>缺失字段</span></article>
      <article><b>{summary.imageBlocksPending}</b><span>待视觉块</span></article>
    </div> : run && <div className={`agent-run-line ${run.status.toLowerCase()}`}><span>{run.status === 'COMPLETED' ? '✓' : run.status === 'FAILED' ? '!' : '…'}</span><div><b>{run.status === 'COMPLETED' ? '最近一次抽取已完成' : run.status === 'FAILED' ? '最近一次抽取失败' : '事实 Agent 运行中'}</b><small>{run.model} · Prompt {run.promptVersion}{run.usage?.total_tokens ? ` · ${run.usage.total_tokens.toLocaleString()} tokens` : ''}</small></div></div>}
  </section>;
}
