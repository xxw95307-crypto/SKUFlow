'use client';

import { useEffect, useState } from 'react';
import type { PlatformId } from '@/lib/domain/platform';
import type { ShopPreferences } from '@/lib/domain/shop-preferences';
import { marketOptionsForPlatform } from '@/lib/platforms/market-options';
import { platformRegistry } from '@/lib/platforms/registry';
import './shop-preferences-dialog.css';

const platforms = platformRegistry.filter((platform) => platform.capabilities.contentGeneration);
const firstPlatform = platforms[0].id;

export function ShopPreferencesDialog({ initial, onSaved, onClose }: {
  initial: ShopPreferences | null;
  onSaved: (preferences: ShopPreferences) => void;
  onClose: () => void;
}) {
  const [brandVoice, setBrandVoice] = useState(initial?.brandVoice ?? '');
  const [bannedText, setBannedText] = useState(initial?.bannedWords.join('、') ?? '');
  const [visualStyle, setVisualStyle] = useState(initial?.visualStyle ?? '');
  const [targets, setTargets] = useState(initial?.preferredTargets ?? []);
  const [platformId, setPlatformId] = useState<PlatformId>(firstPlatform);
  const [market, setMarket] = useState(marketOptionsForPlatform(firstPlatform)[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const addTarget = () => {
    if (!targets.some((target) => target.platformId === platformId && target.market === market)) {
      setTargets((current) => [...current, { platformId, market }]);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/shop-preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          brandVoice,
          bannedWords: bannedText.split(/[、，,\n]+/).map((word) => word.trim()).filter(Boolean),
          preferredTargets: targets,
          visualStyle,
        }),
      });
      const result = await response.json() as { preferences?: ShopPreferences; error?: string };
      if (!response.ok || !result.preferences) throw new Error(result.error || '偏好保存失败');
      onSaved(result.preferences);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '偏好保存失败');
    } finally {
      setBusy(false);
    }
  };

  return <div className="shop-preferences-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="shop-preferences-dialog" role="dialog" aria-modal="true" aria-labelledby="shop-preferences-title" onSubmit={(event) => void save(event)}>
      <header><div><small>店铺记忆</small><h2 id="shop-preferences-title">上新偏好</h2></div><button type="button" aria-label="关闭" disabled={busy} onClick={onClose}>×</button></header>
      <p className="shop-preferences-intro">确认一次，后续商品沿用。商品名称、材质、规格和价格仍以当次资料为准。</p>
      <div className="shop-preferences-fields">
        <label>品牌语气<textarea rows={2} maxLength={300} value={brandVoice} onChange={(event) => setBrandVoice(event.target.value)} placeholder="例如：简洁、亲切，不夸大功效" /></label>
        <label>禁用词<textarea rows={2} value={bannedText} onChange={(event) => setBannedText(event.target.value)} placeholder="用逗号或顿号分隔，例如：最便宜、绝对、100%保证" /><small>只约束新生成的营销文案，不会修改原始商品资料。</small></label>
        <label>视觉偏好<textarea rows={2} maxLength={300} value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)} placeholder="例如：柔和自然光、米白背景、留出标题排版空间" /></label>
        <div className="shop-preferences-targets"><b>常用平台与站点</b><small>新建商品任务时预选，可随时改选。</small>
          {targets.length > 0 && <div className="shop-preferences-chips">{targets.map((target) => <button type="button" key={`${target.platformId}:${target.market}`} title="移除站点" onClick={() => setTargets((current) => current.filter((item) => item.platformId !== target.platformId || item.market !== target.market))}>{platforms.find((item) => item.id === target.platformId)?.shortName ?? target.platformId} · {target.market} ×</button>)}</div>}
          <div className="shop-preferences-add"><select aria-label="平台" value={platformId} onChange={(event) => { const next = event.target.value as PlatformId; setPlatformId(next); setMarket(marketOptionsForPlatform(next)[0]); }}>{platforms.map((platform) => <option key={platform.id} value={platform.id}>{platform.shortName}</option>)}</select><select aria-label="站点" value={market} onChange={(event) => setMarket(event.target.value)}>{marketOptionsForPlatform(platformId).map((option) => <option key={option} value={option}>{option}</option>)}</select><button type="button" onClick={addTarget}>添加</button></div>
        </div>
      </div>
      {error && <p className="shop-preferences-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" disabled={busy}>{busy ? '保存中…' : '确认并保存'}</button></footer>
    </form>
  </div>;
}
