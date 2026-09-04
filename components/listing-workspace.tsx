'use client';

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { ListingFieldDefinition } from '@/lib/domain/listing';
import type { ProductPassport } from '@/lib/domain/product-passport';
import type { TaskSnapshot } from '@/lib/domain/task';
import { platformRegistry } from '@/lib/platforms/registry';
import { isListingDraftPayload } from '@/lib/mock-platforms/listing-compiler';

const sourceLabels = {
  PRODUCT_FACT: '来自商品资料',
  AI_GENERATED: '智能体创作',
  SELLER_INPUT: '需要卖家填写',
} as const;

function editableValue(field: ListingFieldDefinition, value: unknown): string {
  if (field.type === 'string_array') return Array.isArray(value) ? value.join('\n') : '';
  return value === undefined || value === null ? '' : String(value);
}

function ListingFieldEditor({ field, value, issue, onChange }: {
  field: ListingFieldDefinition;
  value: unknown;
  issue?: string;
  onChange: (value: string) => void;
}) {
  const readOnly = field.source === 'PRODUCT_FACT';
  const common = {
    value: editableValue(field, value),
    readOnly,
    placeholder: field.placeholder ?? (field.source === 'AI_GENERATED' ? '由 Listing Agent 生成' : ''),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };
  return <label className={`listing-field ${issue ? 'has-error' : ''}`}>
    <span><b>{field.label}{field.required && <i>*</i>}</b><em className={field.source.toLowerCase()}>{sourceLabels[field.source]}</em></span>
    {field.type === 'text' || field.type === 'string_array'
      ? <textarea {...common} rows={field.type === 'string_array' ? 5 : 6} />
      : <input {...common} inputMode={field.type === 'number' ? 'decimal' : 'text'} />}
    <small>{issue ?? field.helpText ?? (field.type === 'string_array' ? '每行一条' : field.maxLength ? `最多 ${field.maxLength} 个字符` : ' ')}</small>
  </label>;
}

export function ListingWorkspace({ task, onAssets }: { task: TaskSnapshot | null; onAssets: () => void }) {
  const [passport, setPassport] = useState<ProductPassport | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState('');
  const [draftEdits, setDraftEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!task) return;
    const controller = new AbortController();
    fetch(`/api/tasks/${task.id}/passport`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { passport?: ProductPassport; error?: string };
        if (!response.ok || !payload.passport) throw new Error(payload.error || '平台草稿加载失败');
        setPassport(payload.passport);
        setSelectedDraftId((current) => current || payload.passport!.platformDrafts[0]?.id || '');
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
      setMessage(`已生成 ${payload.passport.platformDrafts.length} 个平台/站点版本，请逐个确认。`);
    } catch (caught) {
      setMessage('');
      setError(caught instanceof Error ? caught.message : '多平台 Listing 生成失败');
    } finally { setBusy(false); }
  };

  const persist = async (action: 'save' | 'approve') => {
    if (!task || !selectedDraft) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(`/api/tasks/${task.id}/listing-drafts`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId: selectedDraft.id, action, fields }),
      });
      const payload = await response.json() as { passport?: ProductPassport; error?: string };
      if (!response.ok || !payload.passport) throw new Error(payload.error || 'Listing 保存失败');
      setPassport(payload.passport);
      setDraftEdits((current) => {
        const next = { ...current };
        delete next[selectedDraft.id];
        return next;
      });
      setMessage(action === 'approve' ? '该平台 Listing 已确认。' : '修改已保存并重新校验。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Listing 保存失败');
    } finally { setBusy(false); }
  };

  if (!task) return <section className="panel listing-panel"><h2>请先创建商品任务</h2><p>完成商品资料处理后，才能生成平台 Listing。</p></section>;

  return <section className="panel listing-panel">
    <div className="section-heading"><div><span>STEP 03 · MOCK PLATFORM LISTING</span><h2>生成并确认各平台 Listing</h2><p>系统按平台、站点和类目获取 Mock 字段；客观参数来自资料，营销内容由智能体创作。</p></div><button className="primary" type="button" onClick={generate} disabled={busy}>{busy ? '生成中…' : generatedCount ? '重新生成全部版本' : '生成全部平台版本'}</button></div>
    <div className="mock-mode-note"><b>Mock 平台服务器</b><span>当前字段校验和草稿创建都在模拟环境中执行，不会把商品发送到真实平台。</span></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">{message}</div>}
    <div className="platform-tabs dynamic">{passport?.platformDrafts.map((draft) => <button className={selectedDraft?.id === draft.id ? 'active' : ''} onClick={() => { setSelectedDraftId(draft.id); setError(''); setMessage(''); }} key={draft.id}><b>{platformNames.get(draft.platformId) ?? draft.platformId}</b><small>{draft.market} · {draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED' ? '已确认' : isListingDraftPayload(draft.payload) ? '待确认' : '待生成'}</small></button>)}</div>

    {!listing || !selectedDraft ? <div className="listing-empty"><span>◎</span><h3>尚未生成平台 Listing</h3><p>点击“生成全部平台版本”，系统将调用 Mock Schema 接口，并让百炼填写每个平台的营销字段。</p></div> : <>
      <div className="listing-schema-bar"><div><b>{listing.schema.platformName} · {listing.schema.market}</b><span>{listing.schema.categoryLabel} · {listing.schema.locale}</span></div><code>{listing.schema.schemaVersion}</code></div>
      <div className="listing-form-grid">{listing.schema.fields.map((field) => <ListingFieldEditor
        key={field.key}
        field={field}
        value={fields[field.key]}
        issue={selectedDraft.validationIssues.find((issue) => issue.path === field.key)?.message}
        onChange={(value) => selectedDraft && setDraftEdits((current) => ({
          ...current,
          [selectedDraft.id]: { ...(current[selectedDraft.id] ?? listing.fields), [field.key]: value },
        }))}
      />)}</div>
      <div className="listing-review-actions"><span>{selectedDraft.validationIssues.length ? `${selectedDraft.validationIssues.length} 项需要处理` : '字段校验通过'} · {sourceLabels.AI_GENERATED}内容可以直接修改</span><div><button className="ghost" type="button" onClick={() => persist('save')} disabled={busy}>保存修改</button><button className="primary" type="button" onClick={() => persist('approve')} disabled={busy || selectedDraft.status === 'APPROVED'}>{selectedDraft.status === 'APPROVED' ? '✓ 已确认' : '确认此平台 Listing'}</button></div></div>
    </>}

    <div className="footer-actions"><span>{generatedCount}/{passport?.platformDrafts.length ?? 0} 已生成 · {approvedCount} 已确认</span><button className="primary" type="button" onClick={onAssets} disabled={!allApproved}>全部确认后进入视觉素材 →</button></div>
  </section>;
}
