'use client';

import { useEffect, useState } from 'react';
import type { ParseSummary, ParsedBlock, UnifiedParseResult } from '@/lib/domain/document-parsing';
import type { TaskSnapshot } from '@/lib/domain/task';

const parserLabels = {
  IMAGE: '图片',
  PDF: 'PDF',
  SPREADSHEET: 'Excel / 表格',
  TEXT: '文本',
  UNSUPPORTED: '暂不支持',
} as const;

const statusLabels = {
  COMPLETED: '解析完成',
  PARTIAL: '部分完成',
  FAILED: '解析失败',
} as const;

function resultPreview(result: UnifiedParseResult): string {
  if (result.error) return result.error;
  if (result.text) return result.text.slice(0, 260).replace(/\s+/g, ' ');
  const image = result.blocks.find((block): block is Extract<ParsedBlock, { type: 'image' }> => block.type === 'image');
  if (image) return `${image.format} · ${image.width ?? '?'} × ${image.height ?? '?'} px · 已生成视觉解析块`;
  const table = result.blocks.find((block): block is Extract<ParsedBlock, { type: 'table' }> => block.type === 'table');
  if (table) return `${table.locator.sheet ?? '工作表'} · ${table.headers.length} 列 · ${table.rows.length} 行预览`;
  return '文件已进入统一解析结构。';
}

export function ParseResultsPanel({ task }: { task: TaskSnapshot }) {
  const [results, setResults] = useState<UnifiedParseResult[]>([]);
  const [summary, setSummary] = useState<ParseSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/tasks/${task.id}/parse`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { results?: UnifiedParseResult[]; summary?: ParseSummary; error?: string };
        if (!response.ok) throw new Error(payload.error || '解析结果读取失败');
        setResults(payload.results ?? []);
        setSummary(payload.summary ?? null);
        setError('');
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : '解析结果读取失败');
      });
    return () => controller.abort();
  }, [task.id]);

  const runParser = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/tasks/${task.id}/parse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const payload = await response.json() as { results?: UnifiedParseResult[]; summary?: ParseSummary; error?: string };
      if (!response.ok || !payload.results || !payload.summary) throw new Error(payload.error || '文件解析失败');
      setResults(payload.results);
      setSummary(payload.summary);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '文件解析失败');
    } finally {
      setBusy(false);
    }
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify({ schemaVersion: '1.0', taskId: task.id, summary, results }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${task.id}-parse-results.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return <section className="parse-results-panel">
    <div className="parse-results-heading">
      <div><span className="tiny-label">DAY 03 · UNIFIED PARSE RESULT</span><h3>源文件解析结果</h3><p>所有解析器输出同一个 v1.0 结构，供 Day 4 事实 Agent 消费。</p></div>
      <div><button className="ghost small" type="button" onClick={runParser} disabled={busy}>{busy ? '正在解析…' : '重新解析'}</button><button className="primary small" type="button" onClick={downloadJson} disabled={results.length === 0}>下载统一 JSON</button></div>
    </div>

    {summary && <div className="parse-summary-row">
      <span><b>{summary.total}</b> 文件</span>
      <span className="success"><b>{summary.completed}</b> 完成</span>
      <span className="warning"><b>{summary.partial}</b> 部分完成</span>
      <span className="danger"><b>{summary.failed}</b> 失败</span>
      <span><b>{summary.textCharacters.toLocaleString()}</b> 文本字符</span>
      <span><b>{summary.blocks}</b> 内容块</span>
    </div>}
    {error && <div className="form-error" role="alert">{error}</div>}

    <div className="parse-file-grid">
      {results.length === 0 && !error ? <div className="parse-empty"><b>暂无解析结果</b><span>点击“重新解析”即可为历史任务生成统一结果。</span></div> : results.map((result) => <article className={`parse-file-card ${result.status.toLowerCase()}`} key={result.fileId}>
        <div className="parse-file-top"><span>{parserLabels[result.parserKind]}</span><i>{statusLabels[result.status]}</i></div>
        <h4>{result.filename}</h4>
        <p>{resultPreview(result)}</p>
        <div className="parse-file-meta"><span>{result.metadata.blockCount} 块</span><span>{result.metadata.characterCount.toLocaleString()} 字符</span>{result.metadata.pageCount && <span>{result.metadata.pageCount} 页</span>}{result.metadata.sheetNames && <span>{result.metadata.sheetNames.length} 表</span>}</div>
        {result.warnings.length > 0 && <small>⚠ {result.warnings[0]}</small>}
      </article>)}
    </div>
  </section>;
}
