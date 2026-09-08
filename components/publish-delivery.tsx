'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import type { ProductPassport } from '@/lib/domain/product-passport';
import type { TaskSnapshot } from '@/lib/domain/task';
import { platformRegistry } from '@/lib/platforms/registry';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';

export function PublishDelivery({ task }: { task: TaskSnapshot | null }) {
  const [passport, setPassport] = useState<ProductPassport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const names = useMemo(() => new Map(platformRegistry.map((platform) => [platform.id, platform.shortName])), []);

  useEffect(() => {
    if (!task) return;
    fetch(`/api/tasks/${task.id}/passport`).then(async (response) => {
      const payload = await response.json() as { passport?: ProductPassport; error?: string };
      if (!response.ok || !payload.passport) throw new Error(payload.error || '发布信息加载失败');
      setPassport(payload.passport);
    }).catch((caught) => setError(caught instanceof Error ? caught.message : '发布信息加载失败'));
  }, [task]);

  const publish = async () => {
    if (!task) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(`/api/tasks/${task.id}/publish-mock`, { method: 'POST' });
      const payload = await response.json() as { passport?: ProductPassport; message?: string; error?: string };
      if (!response.ok || !payload.passport) throw new Error(payload.error || '平台测试草稿创建失败');
      setPassport(payload.passport);
      setMessage(payload.message || '平台测试草稿已创建。');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '平台测试草稿创建失败'); }
    finally { setBusy(false); }
  };

  const drafts = passport?.platformDrafts ?? [];
  const approved = drafts.filter((draft) => draft.status === 'APPROVED').length;
  const published = drafts.filter((draft) => draft.status === 'DRAFT_CREATED').length;
  return <section className="panel publish-panel">
    <div className="publish-hero"><div className="ready-mark">✓</div><div><span>STEP 05 · TEST DELIVERY</span><h2>发布交付</h2><p>Shopify 使用官方 Dev Store 创建未公开测试草稿；其他平台暂时保留本地 Mock。</p></div><div className="publish-score"><b>{published || approved}</b><small>可交付版本</small></div></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">✓ {message}</div>}
    <div className="delivery-table"><div className="delivery-head"><span>销售渠道</span><span>站点</span><span>Schema</span><span>状态</span><span>模式</span></div>{drafts.map((draft) => {
      const payload = isListingDraftPayload(draft.payload) ? draft.payload as ListingDraftPayload : null;
      return <div className="delivery-row" key={draft.id}><b>{names.get(draft.platformId) ?? draft.platformId}</b><span>{draft.market}</span><span>{payload?.schema.schemaVersion ?? '未生成'}</span><span className={draft.status === 'DRAFT_CREATED' ? 'ready' : 'review'}><i />{draft.status === 'DRAFT_CREATED' ? '草稿已创建' : draft.status === 'APPROVED' ? '等待创建草稿' : 'Listing 未确认'}</span><span>{draft.platformId === 'shopify' ? 'DEV STORE' : 'MOCK'}</span></div>;
    })}</div>
    <div className="delivery-options"><article><span className="option-icon">↗</span><div><b>创建平台测试草稿</b><p>只处理已审核 Listing；Shopify 商品保持 DRAFT，不会公开上架。</p></div><button className="primary" type="button" onClick={publish} disabled={busy || approved === 0}>{busy ? '创建中…' : `创建 ${approved} 个测试草稿`}</button></article></div>
    <div className="api-note"><b>当前连接范围</b><span>Shopify 已接入官方 Dev Store API；其他平台仍使用 Mock Adapter，后续可逐个替换而不改变审核流程。</span></div>
  </section>;
}
