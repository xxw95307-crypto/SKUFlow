'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import type { ProductPassport } from '@/lib/domain/product-passport';
import type { TaskSnapshot } from '@/lib/domain/task';
import { platformRegistry } from '@/lib/platforms/registry';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';

export function PublishDelivery({ task }: { task: TaskSnapshot | null }) {
  const [passport, setPassport] = useState<ProductPassport | null>(null);
  const [error, setError] = useState('');
  const names = useMemo(() => new Map(platformRegistry.map((platform) => [platform.id, platform.shortName])), []);

  useEffect(() => {
    if (!task) return;
    fetch(`/api/tasks/${task.id}/passport`).then(async (response) => {
      const payload = await response.json() as { passport?: ProductPassport; error?: string };
      if (!response.ok || !payload.passport) throw new Error(payload.error || '发布信息加载失败');
      setPassport(payload.passport);
    }).catch((caught) => setError(caught instanceof Error ? caught.message : '发布信息加载失败'));
  }, [task]);

  const drafts = passport?.platformDrafts ?? [];
  const approved = drafts.filter((draft) => draft.status === 'APPROVED').length;
  const published = drafts.filter((draft) => draft.status === 'DRAFT_CREATED').length;
  return <section className="panel publish-panel">
    <div className="publish-hero"><div className="ready-mark">✓</div><div><span>STEP 05 · TEST DELIVERY</span><h2>发布交付</h2><p>Shopify 使用 Dev Store 创建未公开草稿；Amazon 美国站发送审核稿到官方静态沙箱测试。</p></div><div className="publish-score"><b>{published || approved}</b><small>可交付版本</small></div></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="delivery-table"><div className="delivery-head"><span>销售渠道</span><span>站点</span><span>Schema</span><span>状态</span><span>模式</span></div>{drafts.map((draft) => {
      const payload = isListingDraftPayload(draft.payload) ? draft.payload as ListingDraftPayload : null;
      const amazonSandbox = draft.platformId === 'amazon' && ['US','美国'].includes(draft.market);
      const finished = draft.status === 'DRAFT_CREATED';
      return <div className="delivery-row" key={draft.id}><b>{names.get(draft.platformId) ?? draft.platformId}</b><span>{draft.market}</span><span>{payload?.schema.schemaVersion ?? '未生成'}</span><span className={finished ? 'ready' : 'review'}><i />{finished ? amazonSandbox && payload?.sandboxPublication ? `沙箱测试已完成 · ${payload.sandboxPublication.response.status}` : '草稿已创建' : draft.status === 'APPROVED' ? amazonSandbox ? '等待沙箱测试' : '等待创建草稿' : 'Listing 未确认'}</span><span>{draft.platformId === 'shopify' ? 'DEV STORE' : amazonSandbox ? 'AMAZON SANDBOX' : 'MOCK'}</span></div>;
    })}</div>
    {drafts.filter((draft) => isListingDraftPayload(draft.payload) && draft.payload.sandboxPublication).map((draft) => {
      const result = (draft.payload as unknown as ListingDraftPayload).sandboxPublication!;
      return <div className="api-note" key={`amazon-${draft.id}`}><b>Amazon 美国站 · 官方静态沙箱记录</b><span>已发送 SKU {result.request.sku}、商品类型 {result.request.productType} 的英文 Listing 请求。沙箱返回 {result.response.status}{result.response.issueCodes.length ? `；预设问题代码 ${result.response.issueCodes.join('、')}` : ''}。响应可能包含与本商品不一致的示例 SKU；不表示真实校验通过或已上架。{result.mediaAssetIds.length} 项媒体的顺序已保存在 SKUFlow，未上传至 Amazon。</span></div>;
    })}
    <div className="delivery-options"><article><span className="option-icon">↗</span><div><b>交付记录</b><p>请在对话中确认媒体顺序和最终译文后执行交付。Amazon 官方静态沙箱只返回预设响应，不创建真实商品。</p></div></article></div>
    <div className="api-note"><b>当前连接范围</b><span>Shopify 已接入 Dev Store API；Amazon 美国站已接入官方静态沙箱；其余平台仍使用本地 Mock。</span></div>
  </section>;
}
