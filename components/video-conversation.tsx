'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isReusableVideoJob } from '@/lib/domain/video-job-retry';

type Job = {
  id: string;
  status: string;
  plan: { title: string; prompt: string; duration: number; resolution: string; sourceFileId: string; narrationSuggestion?: string; audioMode?: 'ambient' | 'music' | 'narration'; narrationText?: string };
  error?: string | null;
  videoUrl: string | null;
};
type VideoJobsResponse = { jobs: Job[]; configured: boolean; error?: string };

const labels: Record<string, string> = {
  SUBMITTING: '正在提交', SUBMISSION_UNKNOWN: '提交结果未确认，请核对服务记录',
  PENDING: '排队中', RUNNING: '生成中', FAILED: '生成失败', UNKNOWN: '任务已失效',
};

type AudioMode = 'ambient' | 'music' | 'narration';
function VideoDraft({ job, configured, busy, onStart }: {
  job: Job; configured: boolean; busy: boolean; onStart: (id: string, prompt: string, audioMode: AudioMode, narrationText: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(job.plan.prompt);
  const [audioMode, setAudioMode] = useState<AudioMode>(job.plan.audioMode ?? 'ambient');
  const [narrationText, setNarrationText] = useState(job.plan.narrationText ?? job.plan.narrationSuggestion ?? '');
  return <section className="video-draft-review">
    <div className="video-card-heading"><span>生成前确认</span><b>视频提示词</b></div>
    <textarea aria-label="视频生成提示词" value={prompt} maxLength={4000} rows={7} onChange={(event) => setPrompt(event.target.value)} />
    <fieldset className="video-audio-choice"><legend>声音</legend><div className="video-audio-options">
      <label><input type="radio" name={`audio-${job.id}`} checked={audioMode === 'ambient'} onChange={() => setAudioMode('ambient')} />自然音效</label>
      <label><input type="radio" name={`audio-${job.id}`} checked={audioMode === 'music'} onChange={() => setAudioMode('music')} />背景音乐</label>
      <label><input type="radio" name={`audio-${job.id}`} checked={audioMode === 'narration'} onChange={() => setAudioMode('narration')} />解说配音</label>
    </div></fieldset>
    {audioMode === 'narration' && <label className="video-narration-label">解说文案（生成前可修改）<textarea aria-label="解说文案" value={narrationText} maxLength={60} rows={2} onChange={(event) => setNarrationText(event.target.value)} placeholder="用一句话介绍商品已确认的卖点" /><small>视频会按配音实际时长自动匹配为 2–15 秒；太短或太长时请修改文案。</small></label>}
    <footer><small>{audioMode === 'narration' ? '按配音时长生成' : `${job.plan.duration} 秒`} · {job.plan.resolution} · 可直接修改提示词</small><button type="button" disabled={!configured || busy || !prompt.trim() || (audioMode === 'narration' && !narrationText.trim())} onClick={() => void onStart(job.id, prompt, audioMode, narrationText)}>{busy ? '正在提交…' : '确认并开始生成'}</button></footer>
  </section>;
}

export function VideoConversation({ taskId, revision, selected, onToggle, selectable, showSuggestion = false, sourceImageIds }: {
  taskId: string; revision: number; selected: string[]; onToggle: (id: string) => void;
  selectable: boolean; showSuggestion?: boolean; sourceImageIds?: string[];
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'ai' | 'custom'>('ai');
  const [guidance, setGuidance] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');

  const load = useCallback(async () => {
    const response = await fetch(`/api/tasks/${taskId}/videos`);
    const data = await response.json() as VideoJobsResponse;
    if (!response.ok) throw new Error(data.error || '视频任务读取失败');
    setJobs(data.jobs);
    setConfigured(data.configured);
  }, [taskId]);
  useEffect(() => {
    let active = true;
    fetch(`/api/tasks/${taskId}/videos`)
      .then(async (response) => { const data = await response.json() as VideoJobsResponse; if (!response.ok) throw new Error(data.error || '视频任务读取失败'); return data; })
      .then((data) => { if (active) { setJobs(data.jobs); setConfigured(data.configured); } })
      .catch((caught) => { if (active) setError((caught as Error).message); });
    return () => { active = false; };
  }, [taskId, revision]);

  const sourceKey = sourceImageIds?.join('|') ?? '';
  const visibleJobs = useMemo(() => sourceKey ? jobs.filter((job) => sourceImageIds?.includes(job.plan.sourceFileId)) : jobs, [jobs, sourceKey, sourceImageIds]);
  const draft = visibleJobs.find((job) => job.status === 'DRAFT');
  const inProgress = visibleJobs.some((job) => ['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING', 'RUNNING'].includes(job.status) && isReusableVideoJob(job));
  const results = visibleJobs.filter((job) => job.status === 'SUCCEEDED' && job.videoUrl);
  const latestFailure = visibleJobs.find((job) => ['FAILED', 'UNKNOWN'].includes(job.status) || (job.status === 'SUBMISSION_UNKNOWN' && !isReusableVideoJob(job)));
  const showPlanner = showSuggestion && !draft && !inProgress && results.length === 0;

  const action = useCallback(async (id: string, actionName: 'start' | 'refresh', prompt?: string, audioMode?: AudioMode, narrationText?: string) => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/tasks/${taskId}/videos`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, action: actionName, ...(prompt === undefined ? {} : { prompt, audioMode, narrationText }) }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || '视频操作失败');
      await load();
    } catch (caught) { setError((caught as Error).message); await load().catch(() => undefined); }
    finally { setBusy(false); }
  }, [taskId, load]);

  const createPlan = async () => {
    if (!sourceImageIds?.length) { setError('请先选择用于视频的图片'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/tasks/${taskId}/videos`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, guidance: guidance.trim(), prompt: customPrompt.trim(), selectedImageIds: sourceImageIds, purpose: 'revision' }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || '视频提示词准备失败');
      await load();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const job = visibleJobs.find((item) => ['PENDING', 'RUNNING'].includes(item.status));
    if (!job) return;
    const timer = window.setInterval(() => { if (!busy) void action(job.id, 'refresh'); }, 15000);
    return () => window.clearInterval(timer);
  }, [visibleJobs, busy, action]);

  if (!showSuggestion && results.length === 0) return null;
  return <div className="asset-conversation-card video-results-card">
    {error && <p className="video-inline-error" role="alert">{error}</p>}
    {showPlanner && <section className="video-prompt-choice">
      <h3>你想怎样生成视频？</h3>
      <div className="video-prompt-options" role="group" aria-label="视频提示词方式">
        <button type="button" className={mode === 'ai' ? 'selected' : ''} aria-pressed={mode === 'ai'} onClick={() => setMode('ai')}><b>AI 拟稿</b><span>先生成可编辑的提示词</span></button>
        <button type="button" className={mode === 'custom' ? 'selected' : ''} aria-pressed={mode === 'custom'} onClick={() => setMode('custom')}><b>自己填写</b><span>直接使用你的创意</span></button>
      </div>
      {mode === 'ai' ? <label>补充想法（可选）<textarea rows={2} maxLength={1000} value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="例如：镜头缓慢移动，突出面料质感" /></label>
        : <label>视频生成提示词<textarea rows={5} maxLength={4000} value={customPrompt} onChange={(event) => setCustomPrompt(event.target.value)} placeholder="描述希望出现的画面、镜头和动作" /></label>}
      <footer><small>确认提示词后才会调用视频模型</small><button type="button" disabled={busy || (mode === 'custom' && !customPrompt.trim())} onClick={() => void createPlan()}>{busy ? '正在准备…' : mode === 'ai' ? '生成可编辑提示词' : '保存提示词'}</button></footer>
    </section>}
    {draft && showSuggestion && <VideoDraft key={draft.id} job={draft} configured={configured} busy={busy} onStart={(id, prompt, audioMode, narrationText) => action(id, 'start', prompt, audioMode, narrationText)} />}
    {inProgress && <div className="video-progress-row" role="status"><span className="agent-spinner" /><span>{labels[visibleJobs.find((job) => ['SUBMITTING', 'SUBMISSION_UNKNOWN', 'PENDING', 'RUNNING'].includes(job.status) && isReusableVideoJob(job))?.status ?? ''] || '视频生成中'}</span>{visibleJobs.find((job) => ['PENDING', 'RUNNING'].includes(job.status)) && <button type="button" disabled={busy} onClick={() => void action(visibleJobs.find((job) => ['PENDING', 'RUNNING'].includes(job.status))!.id, 'refresh')}>刷新状态</button>}</div>}
    {results.map((job) => <section className={`video-result${selected.includes(job.id) ? ' selected' : ''}`} key={job.id}>
      <video controls playsInline preload="metadata" src={job.videoUrl!} />
      <div>{selectable && <button className="video-select-button" type="button" aria-pressed={selected.includes(job.id)} onClick={() => onToggle(job.id)}><span aria-hidden="true">{selected.includes(job.id) ? '✓' : '+'}</span>{selected.includes(job.id) ? '已加入上新素材包' : '加入上新素材包'}</button>}<a href={job.videoUrl!} download={`${job.id}.mp4`}>下载视频</a></div>
    </section>)}
    {latestFailure && !inProgress && results.length === 0 && <p className="video-inline-error" role="status">上次生成未成功：{latestFailure.status === 'SUBMISSION_UNKNOWN' ? '视频服务账号状态异常，恢复后可重新生成' : latestFailure.error || labels[latestFailure.status]}</p>}
  </div>;
}
