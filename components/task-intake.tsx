'use client';

import { useRef, useState } from 'react';
import type { PlatformId } from '@/lib/domain/platform';
import { TASK_STATUS_LABELS, type TaskSnapshot } from '@/lib/domain/task';
import { platformRegistry } from '@/lib/platforms/registry';
import { marketOptionsForPlatform, normalizeMarket, type PlatformTarget } from '@/lib/platforms/market-options';

const richMockPlatforms = new Set<PlatformId>(['amazon', 'tiktok-shop', 'shopify', 'shopee']);

const acceptedTypes = '.jpg,.jpeg,.png,.webp,.pdf,.xlsx,.xls,.csv,.txt,.docx';

function initialSelections(initialTargets?: { platforms: PlatformId[]; markets: string[] }): Partial<Record<PlatformId, string[]>> {
  if (!initialTargets || (initialTargets.platforms.length > 1 && initialTargets.markets.length > 1)) return {};
  return Object.fromEntries(initialTargets.platforms.map((platformId) => [platformId,
    initialTargets.markets.map(normalizeMarket).filter((market) => marketOptionsForPlatform(platformId).includes(market)),
  ])) as Partial<Record<PlatformId, string[]>>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function TaskIntake({ onNext, agentManaged = false, initialFiles = [], initialTargets }: {
  onNext: (task: TaskSnapshot) => void;
  agentManaged?: boolean;
  initialFiles?: File[];
  initialTargets?: { platforms: PlatformId[]; markets: string[] };
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [platforms, setPlatforms] = useState<PlatformId[]>(initialTargets?.platforms ?? []);
  const [marketSelections, setMarketSelections] = useState<Partial<Record<PlatformId, string[]>>>(() => initialSelections(initialTargets));
  const [expandedMarkets, setExpandedMarkets] = useState<PlatformId[]>([]);
  const [files, setFiles] = useState<File[]>(initialFiles);
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

  const toggleMarket = (platformId: PlatformId, market: string) => {
    setMarketSelections((current) => {
      const selected = current[platformId] ?? [];
      return { ...current, [platformId]: selected.includes(market) ? selected.filter((item) => item !== market) : [...selected, market] };
    });
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
    if (platforms.length === 0) return setError('请至少选择一个目标平台。');
    const incomplete = platforms.find((platformId) => !(marketSelections[platformId]?.length));
    if (incomplete) return setError(`请为 ${platformRegistry.find((item) => item.id === incomplete)?.shortName ?? incomplete} 选择目标站点。`);
    const targets: PlatformTarget[] = platforms.flatMap((platformId) => (marketSelections[platformId] ?? []).map((market) => ({ platformId, market })));
    const markets = [...new Set(targets.map((target) => target.market))];
    setBusy(true);
    setError('');
    try {
      setProgress('正在安全上传资料…');
      const body = new FormData();
      body.set('markets', JSON.stringify(markets));
      body.set('platforms', JSON.stringify(platforms));
      body.set('targets', JSON.stringify(targets));
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
    {!agentManaged && <div className="section-heading"><div><span>ONE PRODUCT · ALL SOURCES</span><h2>上传同一个商品的全部资料</h2><p>图片、说明书和参数表会被统一处理，直接生成可核对的商品属性。</p></div><em>最多 12 个文件 · 合计 40 MB</em></div>}

    {!agentManaged && <div className="single-product-note"><b>一次任务对应一个商品</b><span>无需提前填写商品名称。请把该商品的图片、参数表、说明书和其他资料一起上传，模型会自动命名、合并属性并检查冲突。</span></div>}

    <div className="intake-fields">
      <fieldset><legend>目标平台 <small>可多选，再分别指定站点</small></legend><div className="platform-choice-grid">{platformRegistry.map((platform) => <button type="button" className={platforms.includes(platform.id) ? 'selected' : ''} onClick={() => togglePlatform(platform.id)} key={platform.id}><b>{platform.shortName}</b><small>{platform.id === 'amazon' ? '官方静态沙箱' : platform.id === 'shopify' ? 'Dev Store 实际字段' : richMockPlatforms.has(platform.id) ? '专用 Mock Schema' : '通用 Mock Schema'}</small></button>)}</div></fieldset>
      {platforms.length === 0 ? <p className="market-selection-empty">先选择平台，再查看该平台可选的目标站点。</p> : <fieldset><legend>目标站点 <small>每个平台分别选择，不会生成无关组合</small></legend><div className="platform-market-list">{platforms.map((platformId) => {
        const profile = platformRegistry.find((item) => item.id === platformId);
        const options = marketOptionsForPlatform(platformId);
        const selected = marketSelections[platformId] ?? [];
        const expanded = expandedMarkets.includes(platformId);
        const visible = options.length > 12 && !expanded ? options.filter((market, index) => index < 8 || selected.includes(market)) : options;
        return <section className="platform-market-group" key={platformId}><div className="platform-market-head"><b>{profile?.shortName ?? platformId}</b><span>{selected.length ? `已选 ${selected.length} 个站点` : '请选择站点'}</span></div><div className="choice-row">{visible.map((market) => <button type="button" aria-pressed={selected.includes(market)} className={selected.includes(market) ? 'selected' : ''} onClick={() => toggleMarket(platformId, market)} key={market}>{market}</button>)}{options.length > 12 && <button type="button" className="market-expand" onClick={() => setExpandedMarkets((current) => expanded ? current.filter((item) => item !== platformId) : [...current, platformId])}>{expanded ? '收起' : `更多站点（${options.length - 8}）`}</button>}</div>{platformId === 'shopify' || platformId === 'woocommerce' ? <small className="market-help">这是内容本地化目标；实际销售范围取决于你的店铺设置。</small> : platformId !== 'amazon' ? <small className="market-help">当前可选的演示市场；该平台尚未接入真实发布。</small> : <small className="market-help">按所选站点接入对应区域的 Amazon 官方静态沙箱。</small>}</section>;
      })}</div></fieldset>}
    </div>

    <input ref={fileInput} className="visually-hidden" type="file" multiple accept={acceptedTypes} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.currentTarget.value = ''; }} />
    <div className={`dropzone ${files.length ? 'compact' : ''}`} role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click(); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
      {files.length ? <><div><b>继续添加商品资料</b><span>可再次选择或拖入图片、PDF、Excel 等文件</span></div><button type="button">＋ 添加文件</button></> : <><div className="upload-icon">↑</div><h3>拖入供应商资料，或点击选择文件</h3><p>支持图片、PDF、Excel、CSV、Word 和文本资料</p><button type="button">选择本地文件</button></>}
    </div>

    <div className="file-list">{files.length === 0 ? <div className="empty-files"><b>尚未选择文件</b><span>建议至少包含商品主图与一份参数资料</span></div> : files.map((file, index) => <div className="file-row" key={`${file.name}:${file.size}`}><span className="file-icon image">{file.name.split('.').pop()?.slice(0, 3).toUpperCase()}</span><div><b>{file.name}</b><small>{formatBytes(file.size)} · 等待安全上传</small></div><button className="remove-file" type="button" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button></div>)}</div>

    {error && <div className="form-error" role="alert">{error}</div>}
    {task ? <div className="task-created"><div><span>✓</span><div><b>{busy ? progress : TASK_STATUS_LABELS[task.status]}</b><small>{task.files.length} 个文件属于同一个商品</small></div></div>{!agentManaged && <button type="button" onClick={continueTask} disabled={busy}>{busy ? '处理中…' : '继续生成商品档案 →'}</button>}</div> : <button className="wide-action" type="button" onClick={createTask} disabled={busy}>{busy ? progress : agentManaged ? '确认并继续' : '上传资料并生成商品档案'} <span>{agentManaged ? '由 Agent 自主选择下一步工具' : '自动提取属性与检查冲突'}</span></button>}
  </section>;
}
