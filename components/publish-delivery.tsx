'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ListingDraftPayload } from '@/lib/domain/listing';
import type { ProductPassport } from '@/lib/domain/product-passport';
import type { TaskSnapshot } from '@/lib/domain/task';
import { platformRegistry } from '@/lib/platforms/registry';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';
import type { AmazonLivePreviewResult } from '@/lib/platforms/amazon-live-preview';

export function PublishDelivery({ task }: { task: TaskSnapshot | null }) {
  const [passport, setPassport] = useState<ProductPassport | null>(null);
  const [error, setError] = useState('');
  const [amazonPreviewBusy, setAmazonPreviewBusy] = useState('');
  const [amazonPreviewError, setAmazonPreviewError] = useState<Record<string, string>>({});
  const [amazonPreviews, setAmazonPreviews] = useState<Record<string, AmazonLivePreviewResult>>({});
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
  const previewAmazon = async (draftId: string) => {
    if (!task) return;
    setAmazonPreviewBusy(draftId);
    setAmazonPreviewError((current) => ({ ...current, [draftId]: '' }));
    try {
      const response = await fetch(`/api/tasks/${task.id}/amazon-live-preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draftId }),
      });
      const payload = await response.json() as { result?: AmazonLivePreviewResult; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error || 'Amazon 正式预校验失败');
      setAmazonPreviews((current) => ({ ...current, [draftId]: payload.result! }));
    } catch (caught) {
      setAmazonPreviewError((current) => ({ ...current, [draftId]: caught instanceof Error ? caught.message : 'Amazon 正式预校验失败' }));
    } finally {
      setAmazonPreviewBusy('');
    }
  };
  return <section className="panel publish-panel">
    <div className="publish-hero"><div className="ready-mark">✓</div><div><span>STEP 05 · TEST DELIVERY</span><h2>发布交付</h2><p>Shopify 使用 Dev Store 创建未公开草稿；Amazon 按所选站点调用对应区域的官方静态沙箱。</p></div><div className="publish-score"><b>{published || approved}</b><small>可交付版本</small></div></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="delivery-table"><div className="delivery-head"><span>销售渠道</span><span>站点</span><span>Schema</span><span>状态</span><span>模式</span></div>{drafts.map((draft) => {
      const payload = isListingDraftPayload(draft.payload) ? draft.payload as ListingDraftPayload : null;
      const amazonSandbox = draft.platformId === 'amazon';
      const finished = draft.status === 'DRAFT_CREATED';
      return <div className="delivery-row" key={draft.id}><b>{names.get(draft.platformId) ?? draft.platformId}</b><span>{draft.market}</span><span>{payload?.schema.schemaVersion ?? '未生成'}</span><span className={finished ? 'ready' : 'review'}><i />{finished ? amazonSandbox && payload?.sandboxPublication ? `沙箱测试已完成 · ${payload.sandboxPublication.response.status}` : '草稿已创建' : draft.status === 'APPROVED' ? amazonSandbox ? '等待沙箱测试' : '等待创建草稿' : 'Listing 未确认'}</span><span>{draft.platformId === 'shopify' ? 'DEV STORE' : amazonSandbox ? 'AMAZON SANDBOX' : 'MOCK'}</span></div>;
    })}</div>
    {drafts.filter((draft) => draft.platformId === 'amazon' && isListingDraftPayload(draft.payload)).map((draft) => {
      const payload = draft.payload as unknown as ListingDraftPayload;
      const result = amazonPreviews[draft.id];
      return <div className="api-note amazon-live-check" key={`amazon-live-${draft.id}`}>
        <b>Amazon {draft.market}站 · 正式字段预校验</b>
        <span>读取官方字段并检查当前 Listing，不会创建商品。</span>
        <button className="ghost" type="button" disabled={amazonPreviewBusy === draft.id || !payload.localization || !['APPROVED', 'DRAFT_CREATED'].includes(draft.status)} onClick={() => void previewAmazon(draft.id)}>{amazonPreviewBusy === draft.id ? '校验中…' : '读取官方字段并预校验'}</button>
        {!payload.localization && <span>请先完成目标站点语言预览。</span>}
        {amazonPreviewError[draft.id] && <span role="alert">{amazonPreviewError[draft.id]}</span>}
        {result && <div role="status"><span>官方 Schema：{result.productType} · {result.schemaVersion ?? '版本未返回'}</span><span>未映射的官方必填字段：{result.missingRequiredAttributes.length ? result.missingRequiredAttributes.join('、') : '无顶层缺项'}</span><span>当前映射中不受支持的字段：{result.unmappedAttributes.length ? result.unmappedAttributes.join('、') : '无'}</span><span>{result.preview ? `正式预校验：${result.preview.status}；${result.preview.issues.length} 项平台问题。` : '当前字段映射与官方 Schema 不一致，尚未发送预校验。'}</span>{result.preview?.issues.map((issue, index) => <span key={`${issue.code ?? 'issue'}-${index}`}>{issue.severity ?? '问题'} · {issue.attributeNames?.join('、') ?? issue.code ?? '字段'}：{issue.message ?? '请到卖家后台核对'}</span>)}<span>预校验不会创建商品；ACCEPTED 也不表示已上架。</span></div>}
      </div>;
    })}
    {drafts.filter((draft) => isListingDraftPayload(draft.payload) && draft.payload.sandboxPublication).map((draft) => {
      const result = (draft.payload as unknown as ListingDraftPayload).sandboxPublication!;
      return <div className="api-note" key={`amazon-${draft.id}`}><b>Amazon {draft.market}站 · 官方静态沙箱记录</b><span>已发送 SKU {result.request.sku}、商品类型 {result.request.productType}、{result.request.currency ?? 'USD'} 售价的目标站点语言 Listing 请求。沙箱返回 {result.response.status}{result.response.issueCodes.length ? `；预设问题代码 ${result.response.issueCodes.join('、')}` : ''}。响应可能包含与本商品不一致的示例 SKU；不表示真实校验通过或已上架。{result.mediaAssetIds.length} 项媒体的顺序已保存在 SKUFlow，未上传至 Amazon。</span></div>;
    })}
    <div className="delivery-options"><article><span className="option-icon">↗</span><div><b>交付记录</b><p>请在对话中确认媒体顺序和最终译文后执行交付。Amazon 官方静态沙箱只返回预设响应，不创建真实商品。</p></div></article></div>
    <div className="api-note"><b>当前连接范围</b><span>Shopify 已接入 Dev Store API；Amazon 已按站点接入北美、欧洲、远东官方静态沙箱；其余平台仍使用本地 Mock。</span></div>
  </section>;
}
