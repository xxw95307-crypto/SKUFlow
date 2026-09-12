'use client';

import { ShopifyLookupEditor, ShopifyVariantsEditor } from '@/components/shopify-field-editors';
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { ListingFieldDefinition, ListingFieldSource } from '@/lib/domain/listing';
import type { ProductPassport } from '@/lib/domain/product-passport';
import type { TaskSnapshot } from '@/lib/domain/task';
import { platformRegistry } from '@/lib/platforms/registry';
import { confirmedInferredFields, isListingDraftPayload, listingFieldSources } from '@/lib/mock-platforms/listing-compiler';

const sourceLabels = {
  PRODUCT_FACT: '来自商品资料',
  AI_GENERATED: '智能体创作',
  AI_INFERRED: '智能体推断',
  SELLER_INPUT: '需要卖家填写',
} as const;

function editableValue(field: ListingFieldDefinition, value: unknown): string {
  if(field.type==='boolean') return value===true?'是':value===false?'否':'';
  if(field.type==='variants') return Array.isArray(value)&&value.length ? `${value.length} 个规格` : '单一规格';
  if (field.type === 'string_array') return Array.isArray(value) ? value.join('\n') : '';
  return value === undefined || value === null ? '' : String(value);
}

function ListingFieldEditor({ field, value, source, confirmed, issue, onChange, onConfirm }: {
  field: ListingFieldDefinition;
  value: unknown;
  source: ListingFieldSource;
  confirmed: boolean;
  issue?: string;
  onChange: (value: unknown) => void;
  onConfirm: (confirmed: boolean) => void;
}) {
  const readOnly = source === 'PRODUCT_FACT';
  const common = {
    value: editableValue(field, value),
    readOnly,
    placeholder: field.placeholder ?? (source === 'AI_GENERATED' || source === 'AI_INFERRED' ? '由 Listing Agent 生成' : ''),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };
  return <div className={`listing-field ${issue ? 'has-error' : ''}`}>
    <span><b>{field.label}{field.required && <i>*</i>}</b><em className={source.toLowerCase()}>{source === 'AI_INFERRED' && !confirmed ? 'AI 推断·待确认' : sourceLabels[source]}</em></span>
    {field.lookup ? <ShopifyLookupEditor field={field} value={value} onChange={onChange}/> : field.type==='variants' ? <ShopifyVariantsEditor value={value} onChange={onChange}/> : field.type==='boolean' ? <select aria-label={field.label} value={value===true?'true':value===false?'false':''} onChange={e=>onChange(e.target.value===''?undefined:e.target.value==='true')}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select> : field.options ? <select aria-label={field.label} value={String(value??'')} onChange={e=>onChange(e.target.value)}><option value="">请选择</option>{field.options.map(o=><option value={o.value} key={o.value}>{o.label}</option>)}</select> : field.type === 'text' || field.type === 'string_array'
      ? <textarea {...common} rows={field.type === 'string_array' ? 5 : 6} />
      : <input {...common} inputMode={field.type === 'number' ? 'decimal' : 'text'} />}
    <small>{issue ?? field.helpText ?? (field.type === 'string_array' ? '每行一条' : field.maxLength ? `最多 ${field.maxLength} 个字符` : ' ')}</small>
    {source === 'AI_INFERRED' && <span className="inference-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => onConfirm(event.target.checked)} />我已核对该推断值</span>}
  </div>;
}

export function ListingWorkspace({ task, onAssets, conversation = false }: {
  task: TaskSnapshot | null;
  onAssets: () => void;
  conversation?: boolean;
}) {
  const [passport, setPassport] = useState<ProductPassport | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState('');
  const [draftEdits, setDraftEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [draftConfirmations, setDraftConfirmations] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (!task) return;
    const controller = new AbortController();
    fetch(`/api/tasks/${task.id}/passport`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { passport?: ProductPassport; error?: string };
        if (!response.ok || !payload.passport) throw new Error(payload.error || '平台草稿加载失败');
        setPassport(payload.passport);
        setSelectedDraftId((current) => current || payload.passport!.platformDrafts.find((draft) => draft.status !== 'APPROVED' && draft.status !== 'DRAFT_CREATED')?.id || payload.passport!.platformDrafts[0]?.id || '');
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : '平台草稿加载失败');
      });
    return () => controller.abort();
  }, [task]);

  const selectedDraft = passport?.platformDrafts.find((draft) => draft.id === selectedDraftId) ?? passport?.platformDrafts[0];
  const listing = selectedDraft && isListingDraftPayload(selectedDraft.payload) ? selectedDraft.payload : null;
  const fields = selectedDraft ? draftEdits[selectedDraft.id] ?? listing?.fields ?? {} : {};
  const fieldSources = listing ? listingFieldSources(listing) : {};
  const confirmations = selectedDraft && listing
    ? draftConfirmations[selectedDraft.id] ?? confirmedInferredFields(listing)
    : [];

  const platformNames = useMemo(() => new Map(platformRegistry.map((platform) => [platform.id, platform.shortName])), []);
  const generatedCount = passport?.platformDrafts.filter((draft) => isListingDraftPayload(draft.payload)).length ?? 0;
  const approvedCount = passport?.platformDrafts.filter((draft) => draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED').length ?? 0;
  const allApproved = Boolean(passport?.platformDrafts.length && approvedCount === passport.platformDrafts.length);

  const generate = async () => {
    if (!task) return;
    setBusy(true); setError(''); setMessage('正在获取各平台字段，并由 Listing Agent 生成内容…');
    try {
      const response = await fetch(`/api/tasks/${task.id}/compile-drafts`, { method: 'POST' });
      const payload = await response.json() as { passport?: ProductPassport; error?: string };
      if (!response.ok || !payload.passport) throw new Error(payload.error || '多平台 Listing 生成失败');
      setPassport(payload.passport);
      setSelectedDraftId(payload.passport.platformDrafts[0]?.id ?? '');
      setDraftEdits({});
      setDraftConfirmations({});
      setMessage(`已生成 ${payload.passport.platformDrafts.length} 个平台的中文审校稿，请逐个确认。`);
    } catch (caught) {
      setMessage('');
      setError(caught instanceof Error ? caught.message : '多平台 Listing 生成失败');
    } finally { setBusy(false); }
  };

  const persist = async (action: 'save' | 'approve') => {
    if (!task || !selectedDraft) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const inferredKeys = listing?.schema.fields
        .filter((field) => (fieldSources[field.key] ?? field.source) === 'AI_INFERRED')
        .map((field) => field.key) ?? [];
      const submittedConfirmations = action === 'approve'
        ? [...new Set([...confirmations, ...inferredKeys])]
        : confirmations;
      const response = await fetch(`/api/tasks/${task.id}/listing-drafts`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId: selectedDraft.id, action, fields, confirmedInferredFields: submittedConfirmations }),
      });
      const payload = await response.json() as { passport?: ProductPassport; error?: string };
      if (payload.passport) setPassport(payload.passport);
      if (!response.ok || !payload.passport) throw new Error(payload.error || 'Listing 保存失败');
      setDraftEdits((current) => {
        const next = { ...current };
        delete next[selectedDraft.id];
        return next;
      });
      setDraftConfirmations((current) => {
        const next = { ...current };
        delete next[selectedDraft.id];
        return next;
      });
      if (action === 'approve') {
        const remaining = payload.passport.platformDrafts.find((draft) => draft.status !== 'APPROVED' && draft.status !== 'DRAFT_CREATED');
        if (remaining) {
          setSelectedDraftId(remaining.id);
          setDetailsOpen(false);
          setMessage('该平台 Listing 已确认，接下来请确认下一份。');
        } else {
          setMessage('所有平台 Listing 均已确认，Agent 将继续生成视觉素材。');
          onAssets();
        }
      } else {
        setMessage('修改已保存并重新校验。');
      }
    } catch (caught) {
      setDetailsOpen(true);
      setError(caught instanceof Error ? caught.message : 'Listing 保存失败');
    } finally { setBusy(false); }
  };

  if (!task) return <section className="panel listing-panel"><h2>请先创建商品任务</h2><p>完成商品资料处理后，才能生成平台 Listing。</p></section>;

  return <section className={conversation ? 'listing-conversation-card' : 'panel listing-panel'}>
    {conversation ? <header className="listing-conversation-head"><span>需要你确认 · 还剩 {Math.max(0, (passport?.platformDrafts.length ?? 0) - approvedCount)} 个平台</span><h3>{listing?.schema.platformName ?? '平台'}中文 Listing 可以使用吗？</h3><p>我已按该平台字段完成中文稿。你可以直接确认，也可以展开修改具体内容。</p></header> : <>
      <div className="section-heading"><div><span>STEP 03 · PLATFORM LISTING REVIEW</span><h2>按平台审核中文 Listing</h2><p>系统按选定平台获取字段，将商品资料映射到对应表单，并由智能体用中文补全各平台的营销内容。</p></div><button className="primary" type="button" onClick={generate} disabled={busy}>{busy ? '生成中…' : generatedCount ? '重新生成中文审校稿' : '生成各平台中文审校稿'}</button></div>
      <div className="mock-mode-note"><b>中文审校阶段</b><span>当前统一使用简体中文审核；目标市场语言仅作为发布元数据，将在后续发布阶段进行本地化。当前仍为 Mock 平台，不会发送到真实平台。</span></div>
    </>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">{message}</div>}
    <div className={`platform-tabs dynamic ${conversation ? 'conversation-tabs' : ''}`}>{passport?.platformDrafts.map((draft) => <button className={selectedDraft?.id === draft.id ? 'active' : ''} onClick={() => { setSelectedDraftId(draft.id); setDetailsOpen(false); setError(''); setMessage(''); }} key={draft.id}><b>{platformNames.get(draft.platformId) ?? draft.platformId}</b><small>{draft.market} · {draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED' ? '已确认' : isListingDraftPayload(draft.payload) ? '待确认' : '待生成'}</small></button>)}</div>

    {!listing || !selectedDraft ? <div className="listing-empty"><span>◎</span><h3>尚未生成平台 Listing</h3><p>点击“生成各平台中文审校稿”，系统将获取平台字段（Shopify 使用真实接口），并让百炼用中文填写每个平台的营销字段。</p></div> : <>
      <div className="listing-schema-bar"><div><b>{listing.schema.platformName} · 中文审校稿</b><span>目标市场：{listing.schema.market} · {listing.schema.mode === 'SHOPIFY_API' ? '按审核原文写入' : `发布时再转换为 ${listing.schema.locale}`} · {listing.schema.categoryLabel}</span></div>{!conversation && <code>{listing.schema.schemaVersion}</code>}</div>
      {listing.schema.platformId === 'shopify' && listing.schema.mode === 'MOCK' && <p role="alert">这是旧版 Mock 审核稿，请重新生成 Listing 获取 Shopify 实际字段后再确认发布。</p>}
      {listing.schema.mode === 'SHOPIFY_API' && <div className="single-product-note"><b>字段来源：Shopify 实际接口 · {listing.schema.storeDomain}</b><span>商品、变体、地点库存、运输及所选图片将在发布时同步；库存需授权读写与地点权限。尚未接入：{listing.schema.unsupportedFields?.join('、')}。发布后逐项回读核对。</span></div>}
      {listing.testPublication?.verification && <div className="single-product-note"><b>Shopify 回读核对</b><ul>{listing.testPublication.verification.map((item) => <li key={item.field}>{item.field}：{item.status === 'MATCH' ? '已核对一致' : item.status === 'MISMATCH' ? '值不一致' : item.status === 'NOT_SYNCED' ? '未同步' : item.status === 'PENDING' ? '平台处理中' : '未能核对'}</li>)}</ul></div>}
      {conversation && !detailsOpen && <dl className="listing-conversation-preview">{listing.schema.fields.slice(0, 5).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{editableValue(field, fields[field.key]) || '待补充'}</dd><span>{sourceLabels[fieldSources[field.key] ?? field.source]}</span></div>)}</dl>}
      {(!conversation || detailsOpen) && <div className="listing-form-grid">{listing.schema.fields.map((field) => <ListingFieldEditor
        key={field.key}
        field={field}
        value={fields[field.key]}
        source={fieldSources[field.key] ?? field.source}
        confirmed={confirmations.includes(field.key)}
        issue={selectedDraft.validationIssues.find((issue) => issue.path === field.key)?.message}
        onChange={(value) => {
          if (!selectedDraft) return;
          setDraftEdits((current) => ({
            ...current,
            [selectedDraft.id]: { ...(current[selectedDraft.id] ?? listing.fields), [field.key]: value },
          }));
          if ((fieldSources[field.key] ?? field.source) === 'AI_INFERRED') {
            setDraftConfirmations((current) => ({
              ...current,
              [selectedDraft.id]: (current[selectedDraft.id] ?? confirmedInferredFields(listing)).filter((key) => key !== field.key),
            }));
          }
        }}
        onConfirm={(checked) => selectedDraft && setDraftConfirmations((current) => {
          const existing = current[selectedDraft.id] ?? confirmedInferredFields(listing);
          return {
            ...current,
            [selectedDraft.id]: checked ? [...new Set([...existing, field.key])] : existing.filter((key) => key !== field.key),
          };
        })}
      />)}</div>}
      <div className="listing-review-actions"><span>{selectedDraft.validationIssues.length ? `${selectedDraft.validationIssues.length} 项需要处理` : '字段校验通过'} · 整体确认会同时核对智能体推断值</span><div>{conversation && <button className="ghost" type="button" onClick={() => setDetailsOpen((current) => !current)}>{detailsOpen ? '收起字段' : '查看并修改'}</button>}{(!conversation || detailsOpen) && <button className="ghost" type="button" onClick={() => persist('save')} disabled={busy}>保存修改</button>}<button className="primary" type="button" onClick={() => persist('approve')} disabled={busy || selectedDraft.status === 'APPROVED'}>{busy ? '确认中…' : selectedDraft.status === 'APPROVED' ? '✓ 已确认' : '确认这份 Listing'}</button></div></div>
    </>}

    {!conversation && <div className="footer-actions"><span>{generatedCount}/{passport?.platformDrafts.length ?? 0} 已生成 · {approvedCount} 已确认</span><button className="primary" type="button" onClick={onAssets} disabled={!allApproved}>全部确认后进入视觉素材 →</button></div>}
  </section>;
}
