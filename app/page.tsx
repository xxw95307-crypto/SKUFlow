'use client';

import { useEffect, useState } from 'react';
import { PassportPanel } from '@/components/passport-panel';
import { ListingWorkspace } from '@/components/listing-workspace';
import { PublishDelivery } from '@/components/publish-delivery';
import { TaskIntake } from '@/components/task-intake';
import type { TaskSnapshot } from '@/lib/domain/task';

type View = 'upload' | 'facts' | 'listing' | 'assets' | 'publish';

const navigation: { id: View; icon: string; label: string }[] = [
  { id: 'upload', icon: '⌁', label: '工作台' },
  { id: 'facts', icon: '▦', label: '商品档案' },
  { id: 'listing', icon: '◎', label: '平台版本' },
  { id: 'assets', icon: '□', label: '素材中心' },
  { id: 'publish', icon: '↗', label: '发布记录' },
];

const stepMap: Record<View, number> = { upload: 0, facts: 1, listing: 2, assets: 3, publish: 4 };
const steps = [['01', '上传资料'], ['02', '商品理解'], ['03', 'Listing 审核'], ['04', '视觉素材'], ['05', '发布交付']];

function ProductVisual({ compact = false }: { compact?: boolean }) {
  return <div className={`product-stage ${compact ? 'compact' : ''}`} aria-label="便携榨汁杯产品示意"><div className="glow" /><div className="blender"><div className="lid" /><div className="cup"><i /><i /><i /></div><div className="base"><span>◎</span></div></div>{!compact && <><span className="color-dot coral" /><span className="color-dot mint" /><span className="color-dot cream" /></>}</div>;
}

function UploadScreen({ onNext }: { onNext: (task: TaskSnapshot) => void }) {
  return <div className="content-grid"><TaskIntake onNext={onNext} /><aside className="panel product-preview"><div className="preview-top"><span>商品资料处理</span><b>统一属性档案</b></div><ProductVisual /><h3>多格式输入，统一商品属性</h3><p>把同一商品的主图、详情图、参数表和说明书一起上传，系统会自动提取并合并可信属性。</p><div className="market-row"><span>支持资料类型</span><b>5 类</b></div><div className="platforms"><span>Image</span><span>PDF</span><span>XLSX/XLS</span><span>CSV</span><span>Text</span></div><div className="notice"><b>自动检查资料冲突</b><p>图片与文档出现不同属性值时会分别保留，不会擅自覆盖，等待商家确认。</p></div></aside></div>;
}

function AssetsScreen({ onNext }: { onNext: () => void }) {
  const assets = [['MAIN · 1:1', '平台白底主图', 'main'], ['LIFESTYLE · 4:5', '办公室随行场景', 'life'], ['INFOGRAPHIC · 1:1', '核心参数信息图', 'info'], ['DETAIL · 3:4', '杯体结构详情图', 'detail']];
  const [selected, setSelected] = useState<string[]>([]);
  return <section className="panel assets-panel"><div className="section-heading"><div><span>STEP 04 · ASSET STUDIO</span><h2>选择平台视觉素材</h2><p>这里先跑通选图流程；接入图像生成模型后，候选图将根据已确认 Listing 和原始实物图生成。</p></div><span className="mock-badge">视觉生成待接入</span></div><div className="asset-toolbar"><div><button className="active">全部候选</button><button>Amazon</button><button>TikTok</button><button>Shopify</button></div><span>{selected.length ? `已选择 ${selected.length} 张` : '请选择至少一张素材'}</span></div><div className="asset-grid">{assets.map(([type, title, kind]) => <article className={`asset-card ${kind} ${selected.includes(title) ? 'selected' : ''}`} key={title} onClick={() => setSelected((current) => current.includes(title) ? current.filter((item) => item !== title) : [...current, title])}><div className="asset-art"><ProductVisual compact />{kind === 'life' && <><span className="desk-line" /><b>Blend<br />anywhere.</b></>}{kind === 'info' && <div className="info-copy"><b>380<small>ML</small></b><span>FACT-BASED</span></div>}{kind === 'detail' && <div className="callouts"><i>Secure lid</i><i>Product detail</i><i>Key feature</i></div>}<span className="asset-check">{selected.includes(title) ? '✓' : '+'}</span></div><div className="asset-meta"><div><small>{type}</small><b>{title}</b></div><button type="button">选择</button></div></article>)}</div><div className="api-note"><b>当前实现边界</b><span>此页是视觉工作流 Mock，不会伪装成真实模型生成结果；下一阶段接入正式图像生成模型与原图一致性校验。</span></div><div className="footer-actions"><span>{selected.length} 张素材已选择</span><button className="primary" onClick={onNext} disabled={selected.length === 0}>确认选图并进入发布 →</button></div></section>;
}

export default function Home() {
  const [view, setView] = useState<View>('upload'); const [toast, setToast] = useState(''); const [activeTask, setActiveTask] = useState<TaskSnapshot | null>(null); const activeStep = stepMap[view];
  useEffect(() => {
    fetch('/api/tasks')
      .then((response) => response.json())
      .then((payload: { tasks?: TaskSnapshot[] }) => setActiveTask(payload.tasks?.[0] ?? null))
      .catch(() => undefined);
  }, []);
  const showToast = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2600); };
  const next = (target: View) => { setView(target); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  return <main className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">S</span><div><strong>SKUFlow</strong><small>AI 智能上新</small></div></div><nav aria-label="工作区导航">{navigation.map(item => <button className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => next(item.id)} key={item.id}><span>{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-note"><span className="live-dot" /> Mock 平台链路<p>平台字段、Listing 校验和草稿创建已通过 Adapter 模拟，后续可替换为真实接口。</p></div><div className="user-card"><span>林</span><div><b>林晓雨</b><small>品牌运营</small></div><i>···</i></div></aside><section className="workspace"><header className="topbar"><div><p className="eyebrow">SOURCE → LISTING → ASSET → DELIVERY</p><h1>SKUFlow · 多平台 Listing Agent</h1></div><div className="top-actions"><button className="ghost" onClick={() => showToast(activeTask ? `当前任务：${activeTask.productName}` : '暂无任务')}>检查状态</button><button className="primary" onClick={() => next('upload')}>新建任务</button></div></header><div className="stepper five">{steps.map(([number, label], index) => <button className={`step ${index === activeStep ? 'current' : ''} ${index < activeStep ? 'done' : ''}`} onClick={() => next((['upload', 'facts', 'listing', 'assets', 'publish'] as View[])[index])} key={number}><span>{index < activeStep ? '✓' : number}</span><div><b>{label}</b><small>{index < activeStep ? '已完成' : index === activeStep ? '进行中' : '待处理'}</small></div></button>)}</div>{view === 'upload' && <UploadScreen onNext={(task) => { setActiveTask(task); next('facts'); }} />}{view === 'facts' && <PassportPanel task={activeTask} onBack={() => next('upload')} onNext={() => next('listing')} onTaskChange={setActiveTask} />}{view === 'listing' && <ListingWorkspace task={activeTask} onAssets={() => next('assets')} />}{view === 'assets' && <AssetsScreen onNext={() => next('publish')} />}{view === 'publish' && <PublishDelivery task={activeTask} />}</section>{toast && <div className="toast"><span>✓</span>{toast}</div>}</main>;
}
