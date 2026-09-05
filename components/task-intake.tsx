'use client';

import { useRef, useState } from 'react';
import type { PlatformId } from '@/lib/domain/platform';
import { TASK_STATUS_LABELS, type TaskSnapshot } from '@/lib/domain/task';
import { defaultPlatformIds, platformRegistry } from '@/lib/platforms/registry';

const richMockPlatforms = new Set<PlatformId>(['amazon', 'tiktok-shop', 'shopify', 'shopee']);

const marketOptions = ['美国', '英国', '德国', '日本', '新加坡', '巴西'];
const acceptedTypes = '.jpg,.jpeg,.png,.webp,.pdf,.xlsx,.xls,.csv,.txt,.docx';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function TaskIntake({ onNext, agentManaged = false }: { onNext: (task: TaskSnapshot) => void; agentManaged?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [markets, setMarkets] = useState<string[]>(['美国']);
  const [platforms, setPlatforms] = useState<PlatformId[]>(defaultPlatformIds);
  const [files, setFiles] = useState<File[]>([]);
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
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

  const generatePassport = async (currentTask: TaskSnapshot) => {
    setProgress('第 1/3 步：正在读取全部商品资料…');
    const parseResponse = await fetch(`/api/tasks/${currentTask.id}/parse`, { method: 'POST' });
    const parsePayload = await parseResponse.json() as { task?: TaskSnapshot; error?: string };
    if (!parseResponse.ok || !parsePayload.task) throw new Error(`资料读取失败：${parsePayload.error || '接口未返回任务状态'}`);

    if (currentTask.files.some((file) => file.contentType.startsWith('image/'))) {
      setProgress('第 2/3 步：正在从实物图提取商品属性…');
      const visionResponse = await fetch(`/api/tasks/${currentTask.id}/analyze-images`, { method: 'POST' });
      const visionPayload = await visionResponse.json() as { error?: string; summary?: { completed: number; failed: number } };
      if (!visionResponse.ok) throw new Error(`图片理解失败：${visionPayload.error || '视觉接口不可用'}`);
      if (!visionPayload.summary || visionPayload.summary.completed === 0) {
        throw new Error(`图片理解失败：${visionPayload.error || `${visionPayload.summary?.failed ?? 0} 张图片未得到模型结果`}`);
      }
    }

    setProgress('第 3/3 步：正在合并商品事实并检查冲突…');
    const factResponse = await fetch(`/api/tasks/${currentTask.id}/extract-facts`, { method: 'POST' });
    const factPayload = await factResponse.json() as { task?: TaskSnapshot; error?: string };
    if (!factResponse.ok || !factPayload.task) throw new Error(`商品事实合并失败：${factPayload.error || '接口未返回任务状态'}`);
    onNext(factPayload.task);
  };

  const createTask = async () => {
    if (files.length === 0) return setError('请先选择至少一个商品资料文件。');
    if (platforms.length === 0 || markets.length === 0) return setError('请至少选择一个目标市场和一个平台。');
    setBusy(true);
    setError('');
    try {
      setProgress('正在安全上传资料…');
      const body = new FormData();
      body.set('markets', JSON.stringify(markets));
      body.set('platforms', JSON.stringify(platforms));
      files.forEach((file) => body.append('files', file));

      const response = await fetch('/api/tasks', { method: 'POST', body });
      const payload = await response.json() as { task?: TaskSnapshot; error?: string };
      if (!response.ok || !payload.task) throw new Error(payload.error || '任务创建失败');
      setTask(payload.task);
      if (agentManaged) onNext(payload.task);
      else await generatePassport(payload.task);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '任务创建失败');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const continueTask = async () => {
    if (!task) return;
    setBusy(true);
    setError('');
    try {
      await generatePassport(task);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '商品档案生成失败');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return <section className="panel upload-panel">
    <div className="section-heading"><div><span>ONE PRODUCT · ALL SOURCES</span><h2>上传同一个商品的全部资料</h2><p>图片、说明书和参数表会被统一处理，直接生成可核对的商品属性。</p></div><em>最多 12 个文件 · 合计 40 MB</em></div>

    <div className="single-product-note"><b>一次任务对应一个商品</b><span>无需提前填写商品名称。请把该商品的图片、参数表、说明书和其他资料一起上传，模型会自动命名、合并属性并检查冲突。</span></div>

    <div className="intake-fields">
      <fieldset><legend>目标市场</legend><div className="choice-row">{marketOptions.map((market) => <button type="button" className={markets.includes(market) ? 'selected' : ''} onClick={() => toggleMarket(market)} key={market}>{market}</button>)}</div></fieldset>
      <fieldset><legend>目标平台 <small>12 个平台均可走 Mock 流程</small></legend><div className="platform-choice-grid">{platformRegistry.map((platform) => <button type="button" className={platforms.includes(platform.id) ? 'selected' : ''} onClick={() => togglePlatform(platform.id)} key={platform.id}><b>{platform.shortName}</b><small>{richMockPlatforms.has(platform.id) ? '专用 Mock Schema' : '通用 Mock Schema'}</small></button>)}</div></fieldset>
    </div>

    <div className="dropzone" role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click(); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
      <input ref={fileInput} className="visually-hidden" type="file" multiple accept={acceptedTypes} onChange={(event) => event.target.files && addFiles(event.target.files)} />
      <div className="upload-icon">↑</div><h3>拖入供应商资料，或点击选择文件</h3><p>支持图片、PDF、Excel、CSV、Word 和文本资料</p><button type="button">选择本地文件</button>
    </div>

    <div className="file-list">{files.length === 0 ? <div className="empty-files"><b>尚未选择文件</b><span>建议至少包含商品主图与一份参数资料</span></div> : files.map((file, index) => <div className="file-row" key={`${file.name}:${file.size}`}><span className="file-icon image">{file.name.split('.').pop()?.slice(0, 3).toUpperCase()}</span><div><b>{file.name}</b><small>{formatBytes(file.size)} · 等待安全上传</small></div><button className="remove-file" type="button" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button></div>)}</div>

    {error && <div className="form-error" role="alert">{error}</div>}
    {task ? <div className="task-created"><div><span>✓</span><div><b>{busy ? progress : TASK_STATUS_LABELS[task.status]}</b><small>{task.files.length} 个文件属于同一个商品</small></div></div>{!agentManaged && <button type="button" onClick={continueTask} disabled={busy}>{busy ? '处理中…' : '继续生成商品档案 →'}</button>}</div> : <button className="wide-action" type="button" onClick={createTask} disabled={busy}>{busy ? progress : agentManaged ? '上传资料并交给 Agent' : '上传资料并生成商品档案'} <span>{agentManaged ? '由 Agent 自主选择下一步工具' : '自动提取属性与检查冲突'}</span></button>}
  </section>;
}
