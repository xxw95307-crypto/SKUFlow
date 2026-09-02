'use client';

import { useRef, useState } from 'react';
import type { PlatformId } from '@/lib/domain/platform';
import { TASK_STATUS_LABELS, type TaskSnapshot } from '@/lib/domain/task';
import { defaultPlatformIds, platformRegistry } from '@/lib/platforms/registry';

const marketOptions = ['美国', '英国', '德国', '日本', '新加坡', '巴西'];
const acceptedTypes = '.jpg,.jpeg,.png,.webp,.pdf,.xlsx,.xls,.csv,.txt,.docx';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function TaskIntake({ onNext }: { onNext: (task: TaskSnapshot) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [productName, setProductName] = useState('BlendGo Mini 便携榨汁杯');
  const [markets, setMarkets] = useState<string[]>(['美国']);
  const [platforms, setPlatforms] = useState<PlatformId[]>(defaultPlatformIds);
  const [files, setFiles] = useState<File[]>([]);
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const addFiles = (incoming: FileList | File[]) => {
    const nextFiles = Array.from(incoming);
    setFiles((current) => {
      const known = new Set(current.map((file) => `${file.name}:${file.size}`));
      return [...current, ...nextFiles.filter((file) => !known.has(`${file.name}:${file.size}`))].slice(0, 12);
    });
    setError('');
  };

  const togglePlatform = (id: PlatformId) => {
    setPlatforms((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const toggleMarket = (market: string) => {
    setMarkets((current) => current.includes(market) ? current.filter((item) => item !== market) : [...current, market]);
  };

  const createTask = async () => {
    if (files.length === 0) {
      setError('请先选择至少一个商品资料文件。');
      return;
    }
    if (platforms.length === 0 || markets.length === 0) {
      setError('请至少选择一个目标市场和一个平台。');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const body = new FormData();
      body.set('productName', productName);
      body.set('markets', JSON.stringify(markets));
      body.set('platforms', JSON.stringify(platforms));
      files.forEach((file) => body.append('files', file));

      const response = await fetch('/api/tasks', { method: 'POST', body });
      const payload = await response.json() as { task?: TaskSnapshot; error?: string };
      if (!response.ok || !payload.task) throw new Error(payload.error || '任务创建失败');
      setTask(payload.task);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '任务创建失败');
    } finally {
      setBusy(false);
    }
  };

  const startIngestion = async () => {
    if (!task) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'INGESTING', note: '用户启动资料解析流程并进入 Product Passport' }),
      });
      const payload = await response.json() as { task?: TaskSnapshot; error?: string };
      if (!response.ok || !payload.task) throw new Error(payload.error || '状态更新失败');
      setTask(payload.task);
      onNext(payload.task);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '状态更新失败');
    } finally {
      setBusy(false);
    }
  };

  return <section className="panel upload-panel">
    <div className="section-heading"><div><span>DAY 01 → DAY 02 · LIVE INTAKE</span><h2>建立多平台上新任务</h2><p>原始文件存入对象存储，同时初始化可追溯的商品事实护照。</p></div><em>最多 12 个文件 · 合计 40 MB</em></div>

    <div className="intake-fields">
      <label><span>商品名称</span><input value={productName} maxLength={120} onChange={(event) => setProductName(event.target.value)} /></label>
      <fieldset><legend>目标市场</legend><div className="choice-row">{marketOptions.map((market) => <button type="button" className={markets.includes(market) ? 'selected' : ''} onClick={() => toggleMarket(market)} key={market}>{market}</button>)}</div></fieldset>
      <fieldset><legend>目标平台 <small>平台注册表已覆盖 12 个平台</small></legend><div className="platform-choice-grid">{platformRegistry.map((platform) => <button type="button" className={platforms.includes(platform.id) ? 'selected' : ''} onClick={() => togglePlatform(platform.id)} key={platform.id}><b>{platform.shortName}</b><small>{platform.supportLevel === 'planned' ? '待接入' : 'Day 1 已注册'}</small></button>)}</div></fieldset>
    </div>

    <div className="dropzone" role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click(); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
      <input ref={fileInput} className="visually-hidden" type="file" multiple accept={acceptedTypes} onChange={(event) => event.target.files && addFiles(event.target.files)} />
      <div className="upload-icon">↑</div><h3>拖入供应商资料，或点击选择文件</h3><p>支持图片、PDF、Excel、CSV、Word 和文本资料</p><button type="button">选择本地文件</button>
    </div>

    <div className="file-list">{files.length === 0 ? <div className="empty-files"><b>尚未选择文件</b><span>建议至少包含商品主图与一份参数资料</span></div> : files.map((file, index) => <div className="file-row" key={`${file.name}:${file.size}`}><span className="file-icon image">{file.name.split('.').pop()?.slice(0, 3).toUpperCase()}</span><div><b>{file.name}</b><small>{formatBytes(file.size)} · 等待安全上传</small></div><button className="remove-file" type="button" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button></div>)}</div>

    {error && <div className="form-error" role="alert">{error}</div>}
    {task ? <div className="task-created"><div><span>✓</span><div><b>{TASK_STATUS_LABELS[task.status]}</b><small>{task.id} · {task.files.length} 个源文件已持久化</small></div></div><button type="button" onClick={startIngestion} disabled={busy}>{busy ? '正在推进…' : '打开商品护照 →'}</button></div> : <button className="wide-action" type="button" onClick={createTask} disabled={busy}>{busy ? '正在创建任务…' : '创建任务并安全上传'} <span>同时初始化 Day 2 数据</span></button>}
  </section>;
}
