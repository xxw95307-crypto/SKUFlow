'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ProductPassport } from '@/lib/domain/product-passport';
import type { TaskSnapshot } from '@/lib/domain/task';
import { platformRegistry } from '@/lib/platforms/registry';
import type { PlatformAdapterDescriptor, PlatformRuleConfig } from '@/lib/platform-sdk/types';

interface AdapterSdkResponse {
  sdkVersion: string;
  interfaceVersion: string;
  adapters: PlatformAdapterDescriptor[];
  coverage: Record<string, string>;
  rules: PlatformRuleConfig[];
}

interface CompileResponse {
  passport?: ProductPassport;
  summary?: {
    compiledDrafts: number;
    validatedDrafts: number;
    reviewDrafts: number;
    mappedFields: number;
    issueCount: number;
  };
  error?: string;
}

export function AdapterSdkPanel({
  task,
  passport,
  onPassportUpdate,
}: {
  task: TaskSnapshot;
  passport: ProductPassport;
  onPassportUpdate: (passport: ProductPassport) => void;
}) {
  const [sdk, setSdk] = useState<AdapterSdkResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<CompileResponse['summary']>(undefined);
  const [selectedDraftId, setSelectedDraftId] = useState(passport.platformDrafts[0]?.id ?? '');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/platform-adapters', { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as AdapterSdkResponse & { error?: string };
        if (!response.ok) throw new Error(payload.error || 'Adapter SDK 加载失败');
        setSdk(payload);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Adapter SDK 加载失败');
      });
    return () => controller.abort();
  }, []);

  const platformNames = useMemo(
    () => new Map(platformRegistry.map((platform) => [platform.id, platform.shortName])),
    [],
  );
  const selectedDraft = passport.platformDrafts.find((draft) => draft.id === selectedDraftId)
    ?? passport.platformDrafts[0];
  const rule = sdk?.rules[0];

  const compileDrafts = async () => {
    setBusy(true);
    setError('');
    setSummary(undefined);
    try {
      const response = await fetch(`/api/tasks/${task.id}/compile-drafts`, { method: 'POST' });
      const payload = await response.json() as CompileResponse;
      if (!response.ok || !payload.passport || !payload.summary) {
        throw new Error(payload.error || '平台草稿编译失败');
      }
      onPassportUpdate(payload.passport);
      setSummary(payload.summary);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '平台草稿编译失败');
    } finally {
      setBusy(false);
    }
  };

  return <section className="adapter-sdk-panel">
    <div className="adapter-sdk-head">
      <div className="sdk-symbol">SDK</div>
      <div>
        <span className="tiny-label">DAY 05 · PLATFORM ADAPTER SDK</span>
        <h3>通用适配器编译台</h3>
        <p>同一份商品护照，通过规则配置编译为任意已登记平台的结构化草稿。</p>
      </div>
      <div className="sdk-version"><b>v{sdk?.sdkVersion ?? '-'}</b><small>接口 {sdk?.interfaceVersion ?? '-'}</small></div>
      <button type="button" onClick={compileDrafts} disabled={busy || !sdk || passport.platformDrafts.length === 0}>
        {busy ? '编译中…' : '编译通用草稿'}
      </button>
    </div>

    <div className="sdk-contract-grid">
      <article><b>{sdk?.adapters.length ?? '-'}</b><span>已注册 Adapter</span><small>注册表按优先级自动解析</small></article>
      <article><b>{sdk ? Object.keys(sdk.coverage).length : '-'}</b><span>覆盖平台</span><small>不仅限于首批 4 个平台</small></article>
      <article><b>{rule?.fields.length ?? '-'}</b><span>通用字段规则</span><small>{rule ? `${rule.id}@${rule.version}` : '正在读取配置'}</small></article>
      <article><b>{passport.platformDrafts.length}</b><span>本任务草稿</span><small>按平台 × 市场独立编译</small></article>
    </div>

    <div className="sdk-body-grid">
      <article className="sdk-rules">
        <div><span className="tiny-label">RULE CONFIG</span><h4>{rule?.title ?? '规则配置加载中'}</h4></div>
        <div className="sdk-rule-list">
          {rule?.fields.map((field) => <span key={field.targetPath}>
            <code>{field.sourceFact}</code><i>→</i><code>{field.targetPath}</code>
          </span>)}
        </div>
      </article>

      <article className="sdk-coverage">
        <div><span className="tiny-label">ADAPTER REGISTRY</span><h4>平台注册覆盖</h4></div>
        <div className="sdk-platform-list">
          {platformRegistry.map((platform) => <span key={platform.id} className={sdk?.coverage[platform.id] ? 'covered' : ''}>
            <i />{platform.shortName}
          </span>)}
        </div>
      </article>
    </div>

    {summary && <div className="sdk-result" role="status">
      <span>✓</span><div><b>已编译 {summary.compiledDrafts} 个草稿，映射 {summary.mappedFields} 个字段</b><small>{summary.validatedDrafts} 个通过通用校验 · {summary.reviewDrafts} 个待补充 · {summary.issueCount} 条问题</small></div>
    </div>}
    {error && <div className="sdk-error" role="alert">{error}</div>}

    {selectedDraft && Object.keys(selectedDraft.payload).length > 0 && <div className="sdk-preview">
      <div>
        <span className="tiny-label">COMPILED PAYLOAD</span>
        <select value={selectedDraft.id} onChange={(event) => setSelectedDraftId(event.target.value)}>
          {passport.platformDrafts.map((draft) => <option value={draft.id} key={draft.id}>
            {platformNames.get(draft.platformId) ?? draft.platformId} · {draft.market}
          </option>)}
        </select>
      </div>
      <pre>{JSON.stringify(selectedDraft.payload, null, 2)}</pre>
    </div>}
  </section>;
}
