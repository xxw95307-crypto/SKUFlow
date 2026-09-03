'use client';

import { useEffect, useState } from 'react';
import { PassportPanel } from '@/components/passport-panel';
import { TaskIntake } from '@/components/task-intake';
import type { TaskSnapshot } from '@/lib/domain/task';

type View = 'upload' | 'facts' | 'listing' | 'assets' | 'publish';
type Platform = 'Amazon' | 'TikTok Shop' | 'Shopify' | 'Shopee';

const navigation: { id: View; icon: string; label: string }[] = [
  { id: 'upload', icon: '⌁', label: '工作台' },
  { id: 'facts', icon: '▦', label: '商品档案' },
  { id: 'listing', icon: '◎', label: '平台版本' },
  { id: 'assets', icon: '□', label: '素材中心' },
  { id: 'publish', icon: '↗', label: '发布记录' },
];

const stepMap: Record<View, number> = { upload: 0, facts: 1, listing: 2, assets: 2, publish: 3 };
const steps = [['01', '上传资料'], ['02', '事实档案'], ['03', '平台编译'], ['04', '发布交付']];
const listingContent: Record<Platform, { score: number; market: string; title: string; bullets: string[]; note: string }> = {
  Amazon: { score: 92, market: 'Amazon US · English', title: 'BlendGo Mini Portable Blender, 380ml Personal Smoothie Maker with 6-Blade System, USB-C Rechargeable Travel Blender for Shakes', bullets: ['380ML PERSONAL SIZE — Blend directly in the cup for smoothies and shakes on the go.', '6-BLADE MIXING SYSTEM — Designed for fruit, milk and soft ingredients.', 'FOOD-CONTACT PCTG CUP — Lightweight cup with a secure drinking lid.'], note: '标题 154/200 字符 · 后台搜索词待生成' },
  'TikTok Shop': { score: 88, market: 'TikTok Shop US · English', title: 'Fresh smoothies anywhere 🍓 BlendGo Mini USB-C Portable Blender', bullets: ['One cup. One button. Fresh in minutes.', '380ml travel-friendly size', 'Easy USB-C charging for your daily routine'], note: '短标题已适配移动端 · 禁用绝对化功效词' },
  Shopify: { score: 95, market: 'DTC Store · English', title: 'BlendGo Mini — Your smoothie routine, made portable.', bullets: ['Make a fresh blend at your desk, after the gym, or wherever the day takes you.', 'A compact 380ml cup, six-blade mixing system and simple one-button control.', 'Choose your color, charge by USB-C, and take your blend to go.'], note: 'SEO 标题与 Meta description 已生成' },
  Shopee: { score: 84, market: 'Shopee SG · English', title: 'BlendGo Mini Portable Blender 380ml USB-C Rechargeable Personal Juice Cup', bullets: ['Compact 380ml cup for daily smoothies and shakes.', 'USB-C rechargeable design for home, office and travel.', 'Product facts remain locked until missing battery information is confirmed.'], note: 'Day 1 Adapter 已注册 · 类目字段 Schema 待接入' },
};

function ProductVisual({ compact = false }: { compact?: boolean }) {
  return <div className={`product-stage ${compact ? 'compact' : ''}`} aria-label="便携榨汁杯产品示意"><div className="glow" /><div className="blender"><div className="lid" /><div className="cup"><i /><i /><i /></div><div className="base"><span>◎</span></div></div>{!compact && <><span className="color-dot coral" /><span className="color-dot mint" /><span className="color-dot cream" /></>}</div>;
}

function UploadScreen({ onNext }: { onNext: (task: TaskSnapshot) => void }) {
  return <div className="content-grid"><TaskIntake onNext={onNext} /><aside className="panel product-preview"><div className="preview-top"><span>商品资料处理</span><b>统一属性档案</b></div><ProductVisual /><h3>多格式输入，统一商品属性</h3><p>把同一商品的主图、详情图、参数表和说明书一起上传，系统会自动提取并合并可信属性。</p><div className="market-row"><span>支持资料类型</span><b>5 类</b></div><div className="platforms"><span>Image</span><span>PDF</span><span>XLSX/XLS</span><span>CSV</span><span>Text</span></div><div className="notice"><b>自动检查资料冲突</b><p>图片与文档出现不同属性值时会分别保留，不会擅自覆盖，等待商家确认。</p></div></aside></div>;
}

function ListingScreen({ onAssets }: { onAssets: () => void }) {
  const [platform, setPlatform] = useState<Platform>('Amazon'); const content = listingContent[platform];
  return <section className="panel listing-panel"><div className="section-heading"><div><span>STEP 03 · PLATFORM COMPILER</span><h2>一份事实，多套平台表达</h2><p>不是机械翻译，而是按照平台字段、语气和禁用规则重新编译。</p></div><button className="ghost small">中 / EN</button></div><div className="platform-tabs">{(Object.keys(listingContent) as Platform[]).map(item => <button className={platform === item ? 'active' : ''} onClick={() => setPlatform(item)} key={item}>{item}<small>{item === 'Amazon' ? 'Marketplace' : item === 'Shopify' ? 'DTC Store' : item === 'Shopee' ? 'Regional marketplace' : 'Social commerce'}</small></button>)}</div><div className="listing-workspace"><div className="listing-editor"><div className="editor-top"><span>{content.market}</span><b>内容完整度 {content.score}%</b></div><label>商品标题 <small>{content.title.length}/200</small></label><div className="editable title-copy">{content.title}</div><label>核心卖点 <small>3 条</small></label><div className="bullet-list">{content.bullets.map((bullet, i) => <div key={bullet}><span>0{i + 1}</span><p>{bullet}</p></div>)}</div><div className="editor-note"><span>✓</span>{content.note}</div></div><aside className="rule-panel"><span className="tiny-label">RULE CHECK</span><h3>平台规则检查</h3><div className="rule-score"><b>{content.score}</b><span>/ 100<br />可发布</span></div><ul><li><i />未发现绝对化承诺</li><li><i />敏感词检查通过</li><li><i />字符长度符合要求</li><li className="warning"><i />电池信息待补充</li></ul><button onClick={onAssets}>查看配套图片素材 →</button></aside></div></section>;
}

function AssetsScreen({ onNext }: { onNext: () => void }) {
  const assets = [['MAIN · 1:1', '平台白底主图', 'main'], ['LIFESTYLE · 4:5', '办公室随行场景', 'life'], ['INFOGRAPHIC · 1:1', '核心参数信息图', 'info'], ['DETAIL · 3:4', '杯体结构详情图', 'detail']];
  return <section className="panel assets-panel"><div className="section-heading"><div><span>STEP 03 · ASSET STUDIO</span><h2>多平台视觉素材包</h2><p>基于已确认事实生成；产品结构保持一致，背景与版式按渠道适配。</p></div><button className="ghost small">+ 新建素材</button></div><div className="asset-toolbar"><div><button className="active">全部 8</button><button>Amazon 6</button><button>TikTok 4</button><button>Shopify 5</button></div><span>✓ 商品一致性检查通过</span></div><div className="asset-grid">{assets.map(([type, title, kind], i) => <article className={`asset-card ${kind}`} key={title}><div className="asset-art"><ProductVisual compact />{kind === 'life' && <><span className="desk-line" /><b>Blend<br />anywhere.</b></>}{kind === 'info' && <div className="info-copy"><b>380<small>ML</small></b><span>6-BLADE</span></div>}{kind === 'detail' && <div className="callouts"><i>Secure lid</i><i>PCTG cup</i><i>One button</i></div>}<span className="asset-check">✓</span></div><div className="asset-meta"><div><small>{type}</small><b>{title}</b></div><button>···</button></div>{i === 2 && <span className="asset-warn">功率数字已隐藏，等待确认</span>}</article>)}</div><div className="footer-actions"><span>已生成 8 张 · 4 张可发布 · 4 张待选择</span><button className="primary" onClick={onNext}>进入发布检查</button></div></section>;
}

function PublishScreen({ onToast }: { onToast: (message: string) => void }) {
  const rows = [['Amazon US', '英文', '6 张', '1 项待确认', 'review'], ['TikTok Shop US', '英文', '4 张', '检查通过', 'ready'], ['Shopify DTC', '英文', '5 张', '检查通过', 'ready'], ['Shopee SG', '英文', '4 张', 'Schema 待接入', 'review']];
  return <section className="panel publish-panel"><div className="publish-hero"><div className="ready-mark">✓</div><div><span>STEP 04 · READY TO SHIP</span><h2>上架包已准备就绪</h2><p>共生成 4 个参考平台版本；其余平台通过 Adapter Registry 持续接入。</p></div><div className="publish-score"><b>94</b><small>整体就绪度</small></div></div><div className="delivery-table"><div className="delivery-head"><span>销售渠道</span><span>语言</span><span>素材</span><span>发布检查</span><span>操作</span></div>{rows.map(([channel, lang, asset, status, state]) => <div className="delivery-row" key={channel}><b>{channel}</b><span>{lang}</span><span>{asset}</span><span className={state}><i />{status}</span><button onClick={() => onToast(`${channel} 预览已生成`)}>预览</button></div>)}</div><div className="delivery-options"><article><span className="option-icon">↓</span><div><b>导出平台上架包</b><p>包含 XLSX 字段表、文案、图片与审核报告</p></div><button onClick={() => onToast('演示：上架包已加入下载队列')}>导出 ZIP</button></article><article><span className="option-icon">↗</span><div><b>创建平台草稿</b><p>需卖家授权与正式 API 权限；当前为 Mock 演示</p></div><button className="primary" onClick={() => onToast('Mock：已模拟创建平台草稿')}>Mock 发布</button></article></div><div className="api-note"><b>实现边界说明</b><span>文案、字段映射、规则预检和素材包可独立实现；自动写入各平台取决于商家授权、平台 API 开放范围及类目权限。</span></div></section>;
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
  return <main className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">S</span><div><strong>SKUFlow</strong><small>AI 智能上新</small></div></div><nav aria-label="工作区导航">{navigation.map(item => <button className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => next(item.id)} key={item.id}><span>{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-note"><span className="live-dot" /> 统一商品理解<p>同一个 qwen3.8-max 处理图片与文档，并通过证据链检查属性冲突。</p></div><div className="user-card"><span>林</span><div><b>林晓雨</b><small>品牌运营</small></div><i>···</i></div></aside><section className="workspace"><header className="topbar"><div><p className="eyebrow">ONE PRODUCT · ALL SOURCES</p><h1>SKUFlow · 多源商品属性助手</h1></div><div className="top-actions"><button className="ghost" onClick={() => showToast(activeTask ? `当前任务：${activeTask.id}` : '暂无任务')}>检查状态</button><button className="primary" onClick={() => next('upload')}>新建任务</button></div></header><div className="stepper">{steps.map(([number, label], index) => <button className={`step ${index === activeStep ? 'current' : ''} ${index < activeStep ? 'done' : ''}`} onClick={() => next((['upload', 'facts', 'listing', 'publish'] as View[])[index])} key={number}><span>{index < activeStep ? '✓' : number}</span><div><b>{label}</b><small>{index < activeStep ? '已完成' : index === activeStep ? '进行中' : '待处理'}</small></div></button>)}</div>{view === 'upload' && <UploadScreen onNext={(task) => { setActiveTask(task); next('facts'); }} />}{view === 'facts' && <PassportPanel task={activeTask} onBack={() => next('upload')} onNext={() => next('listing')} onTaskChange={setActiveTask} />}{view === 'listing' && <ListingScreen onAssets={() => next('assets')} />}{view === 'assets' && <AssetsScreen onNext={() => next('publish')} />}{view === 'publish' && <PublishScreen onToast={showToast} />}</section>{toast && <div className="toast"><span>✓</span>{toast}</div>}</main>;
}
