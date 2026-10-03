import { useState } from 'react';
import type { PlatformId } from '@/lib/domain/platform';
import type { PlatformDraft } from '@/lib/domain/product-passport';
import { platformRegistry } from '@/lib/platforms/registry';
import { marketOptionsForPlatform, type PlatformTarget } from '@/lib/platforms/market-options';

export function TaskTargetEditor({ taskId, drafts, onSaved, onCancel }: {
  taskId: string;
  drafts: PlatformDraft[];
  onSaved: (targets: PlatformTarget[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<PlatformTarget[]>(() => drafts.map(({ platformId, market }) => ({ platformId, market })));
  const [expanded, setExpanded] = useState<PlatformId[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const platforms = [...new Set(selected.map(({ platformId }) => platformId))];

  const togglePlatform = (platformId: PlatformId) => {
    if (platforms.includes(platformId)) {
      setSelected((current) => current.filter((target) => target.platformId !== platformId));
      return;
    }
    // Select a platform first; the seller chooses its markets explicitly below.
    setSelected((current) => [...current, { platformId, market: '' }]);
  };
  const toggleMarket = (platformId: PlatformId, market: string) => {
    setSelected((current) => {
      if (!current.some((target) => target.platformId === platformId && target.market === market)) {
        return [...current.filter((target) => target.platformId !== platformId || target.market !== ''), { platformId, market }];
      }
      const rest = current.filter((target) => target.platformId !== platformId || target.market !== market);
      return rest.some((target) => target.platformId === platformId) ? rest : [...rest, { platformId, market: '' }];
    });
  };
  const save = async () => {
    if (!platforms.length) return setError('请至少选择一个平台。');
    if (platforms.some((platformId) => !selected.some((target) => target.platformId === platformId && target.market))) {
      return setError('请为每个平台选择至少一个站点。');
    }
    setBusy(true); setError('');
    try {
      const targets = selected.filter((target) => target.market);
      const response = await fetch(`/api/tasks/${taskId}/targets`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targets }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || '目标更新失败');
      await onSaved(targets);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '目标更新失败');
    } finally { setBusy(false); }
  };

  return <section className="target-editor chat-action-card" aria-label="重新选择平台和站点">
    <div className="target-editor-heading"><div><span>返回选择</span><h3>重新选择平台和站点</h3></div><button type="button" onClick={onCancel} disabled={busy} aria-label="关闭选择卡">×</button></div>
    <p>商品资料和已确认的属性会保留。保存后，原平台的 Listing 审校稿需要重新生成。</p>
    <fieldset><legend>目标平台</legend><div className="platform-choice-grid">{platformRegistry.map((platform) =>
      <button key={platform.id} type="button" className={platforms.includes(platform.id) ? 'selected' : ''} aria-pressed={platforms.includes(platform.id)} disabled={busy} onClick={() => togglePlatform(platform.id)}>{platform.shortName}</button>)}</div></fieldset>
    {platforms.map((platformId) => {
      const options = marketOptionsForPlatform(platformId);
      const chosen = selected.filter((target) => target.platformId === platformId && target.market).map((target) => target.market);
      const showAll = expanded.includes(platformId);
      const visible = showAll || options.length <= 12 ? options : options.filter((market, index) => index < 8 || chosen.includes(market));
      return <fieldset key={platformId}><legend>{platformRegistry.find((platform) => platform.id === platformId)?.shortName ?? platformId} · 目标站点</legend>
        <div className="choice-row">{visible.map((market) => <button key={market} type="button" className={chosen.includes(market) ? 'selected' : ''} aria-pressed={chosen.includes(market)} disabled={busy} onClick={() => toggleMarket(platformId, market)}>{market}</button>)}
          {options.length > 12 && <button type="button" disabled={busy} onClick={() => setExpanded((current) => showAll ? current.filter((id) => id !== platformId) : [...current, platformId])}>{showAll ? '收起' : '更多站点'}</button>}</div>
      </fieldset>;
    })}
    {error && <div className="form-error" role="alert">{error}</div>}
    <footer><button type="button" onClick={onCancel} disabled={busy}>取消</button><button className="primary" type="button" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存并重新生成 Listing'}</button></footer>
  </section>;
}
