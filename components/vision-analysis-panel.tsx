'use client';

import { useEffect, useMemo, useState } from 'react';
import type { TaskSnapshot } from '@/lib/domain/task';
import type { VisionAgentRun, VisionAnalysisSummary } from '@/lib/domain/vision-analysis';

interface VisionFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

interface VisionProvider {
  name: string;
  model: string;
  configured: boolean;
  missing: string[];
}

interface VisionStateResponse {
  provider?: VisionProvider;
  files?: VisionFile[];
  runs?: VisionAgentRun[];
  summary?: VisionAnalysisSummary;
  error?: string;
}

const runLabels = {
  RUNNING: '分析中',
  COMPLETED: '视觉理解完成',
  FAILED: '分析失败',
} as const;

export function VisionAnalysisPanel({ task }: { task: TaskSnapshot }) {
  const [provider, setProvider] = useState<VisionProvider | null>(null);
  const [files, setFiles] = useState<VisionFile[]>([]);
  const [runs, setRuns] = useState<VisionAgentRun[]>([]);
  const [summary, setSummary] = useState<VisionAnalysisSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/tasks/${task.id}/analyze-images`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as VisionStateResponse;
        if (!response.ok || !payload.provider) throw new Error(payload.error || '视觉 Agent 状态读取失败');
        setProvider(payload.provider);
        setFiles(payload.files ?? []);
        setRuns(payload.runs ?? []);
        setSummary(payload.summary ?? null);
        setError('');
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : '视觉 Agent 状态读取失败');
      });
    return () => controller.abort();
  }, [task.id]);

  const runByFile = useMemo(() => new Map(runs.map((run) => [run.fileId, run])), [runs]);

  const analyzeImages = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/tasks/${task.id}/analyze-images`, { method: 'POST' });
      const payload = await response.json() as VisionStateResponse;
      if (!response.ok || !payload.runs || !payload.summary) {
        throw new Error(payload.error || '图片视觉分析失败');
      }
      setRuns(payload.runs);
      setSummary(payload.summary);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片视觉分析失败');
    } finally {
      setBusy(false);
    }
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify({ schemaVersion: '1.0', taskId: task.id, summary, runs }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${task.id}-vision-results.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return <section className="vision-agent-panel">
    <div className="vision-agent-head">
      <div className="vision-symbol">VL</div>
      <div>
        <span className="tiny-label">VISION AGENT · IMAGE UNDERSTANDING</span>
        <h3>百炼商品视觉理解 Agent</h3>
        <p>读取 R2 原图，识别可见文字与商品属性，并生成可定位的视觉证据。</p>
      </div>
      <div className="agent-provider"><i className={provider?.configured ? 'online' : ''} /><span>{provider?.name ?? '阿里云百炼视觉'}<small>{provider?.model ?? '读取配置中'}</small></span></div>
      <div className="vision-actions">
        <button className="ghost small" type="button" onClick={downloadJson} disabled={runs.length === 0}>下载视觉 JSON</button>
        <button type="button" onClick={analyzeImages} disabled={busy || !provider?.configured || files.length === 0}>
          {busy ? '逐图分析中…' : summary?.completed ? '分析新增/失败图片' : '启动视觉理解'}
        </button>
      </div>
    </div>

    {!provider?.configured && provider && <div className="vision-config-note">
      <b>视觉模型尚未配置</b>
      <span>还需在服务端填写 {provider.missing.join('、')}。现有 Token Plan 文本端点不会被错误复用。</span>
    </div>}
    {provider?.configured && <div className="vision-security-note">
      <b>私有图片链路</b><span>图片从 R2 读取并以 Base64 请求视觉模型，不生成公开文件 URL；模型输出独立存档后交给事实 Agent。</span>
    </div>}
    {error && <div className="form-error" role="alert">{error}</div>}

    {summary && <div className="vision-summary-grid">
      <article><b>{summary.totalImages}</b><span>任务图片</span></article>
      <article><b>{summary.completed}</b><span>理解完成</span></article>
      <article><b>{summary.factsObserved}</b><span>视觉事实</span></article>
      <article><b>{summary.visibleTextCharacters.toLocaleString()}</b><span>可见文字</span></article>
      <article className={summary.failed > 0 ? 'warn' : ''}><b>{summary.failed}</b><span>失败</span></article>
    </div>}

    <div className="vision-file-list">
      {files.length === 0 ? <div className="vision-empty">当前任务没有图片。上传并完成源文件解析后即可运行。</div> : files.map((file) => {
        const run = runByFile.get(file.id);
        return <article key={file.id} className={run?.status.toLowerCase() ?? 'pending'}>
          <div><span>{run ? runLabels[run.status] : '等待视觉理解'}</span><small>{(file.size / 1024).toFixed(0)} KB</small></div>
          <h4>{file.filename}</h4>
          {run?.result ? <>
            <p>{run.result.summary || '图片已完成分析。'}</p>
            <div className="vision-fact-chips">{run.result.facts.slice(0, 8).map((fact) => <span key={fact.key}><b>{fact.label}</b>{String(fact.value)}{fact.unit ? ` ${fact.unit}` : ''}</span>)}</div>
            {run.result.visibleText && <small className="vision-ocr">OCR · {run.result.visibleText.slice(0, 180)}</small>}
          </> : <p>{run?.error || '等待模型提取文字、属性和图片区域坐标。'}</p>}
        </article>;
      })}
    </div>
  </section>;
}
