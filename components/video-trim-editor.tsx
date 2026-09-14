'use client';
import { useEffect, useRef, useState } from 'react';
import { trimVideo } from '@/lib/client/trim-video';
import { validateVideoTrimRange } from '@/lib/domain/video-trim';

export interface TrimSource { id: string; videoUrl: string | null; status: string; plan: { title: string; duration: number } }
export interface TrimDraft { id: string; plan: { trim: { sourceVideoId?: string | null; start?: number | null; end?: number | null; guidance?: string } } }

export function VideoTrimEditor({ taskId, draft, sources, onSaved }: { taskId: string; draft: TrimDraft; sources: TrimSource[]; onSaved: (id: string) => void }) {
  const [sourceId, setSourceId] = useState(draft.plan.trim.sourceVideoId ?? '');
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(draft.plan.trim.start ?? 0);
  const [end, setEnd] = useState(draft.plan.trim.end ?? 0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ blob: Blob; url: string; start: number; end: number } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const source = sources.find(s => s.id === sourceId);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  const reset = () => { setResult(null); setError(''); };
  const generate = async () => {
    setError(''); setBusy(true); setProgress(0); setResult(null);
    try {
      validateVideoTrimRange(start, end, duration);
      if (!video.current) throw new Error('请先选择并加载原视频');
      const blob = await trimVideo(video.current, start, end, setProgress);
      setResult({ blob, url: URL.createObjectURL(blob), start, end });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!result) return;
    setBusy(true); setError('');
    try {
      const form = new FormData(); form.set('trimId', draft.id); form.set('sourceVideoId', sourceId);
      form.set('start', String(result.start)); form.set('end', String(result.end));
      form.set('file', result.blob, result.blob.type === 'video/webm' ? 'trim.webm' : 'trim.mp4');
      const r = await fetch(`/api/tasks/${taskId}/video-trims`, { method: 'PUT', body: form });
      const data = await r.json() as {id:string;error?:string}; if (!r.ok) throw new Error(data.error || '裁剪保存失败');
      onSaved(data.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="video-trim-card" aria-label="视频裁剪确认">
    <header><span>需要你确认 · 视频裁剪</span><h3>保留需要的片段</h3><p>{draft.plan.trim.guidance || '选择视频并调整保留时段，预览后采用裁剪版。'}</p></header>
    <label className="video-trim-source">目标视频<select value={sourceId} disabled={busy} onChange={e => { setSourceId(e.target.value); setDuration(0); setStart(0); setEnd(0); reset(); }}>
      <option value="">请选择要裁剪的视频</option>{sources.map((s, index) => <option key={s.id} value={s.id}>视频 {index + 1} · {s.plan.title}</option>)}
    </select></label>
    {source?.videoUrl && <video ref={video} key={sourceId} src={source.videoUrl} controls playsInline preload="metadata" onLoadedMetadata={e => {
      const d = Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : source.plan.duration;
      setDuration(d); setEnd(value => value > 0 ? Math.min(value, d) : d);
    }} onError={() => setError('原视频加载失败，请刷新后重试')} />}
    {source && <><div className="video-trim-range"><label>保留起点（秒）<input type="number" min="0" max={duration} step="0.1" value={start} disabled={busy} onChange={e => { setStart(Number(e.target.value)); reset(); }} /></label>
      <label>保留终点（秒）<input type="number" min="0" max={duration} step="0.1" value={end} disabled={busy} onChange={e => { setEnd(Number(e.target.value)); reset(); }} /></label></div>
      <div className="video-trim-shortcuts"><button type="button" disabled={busy || !duration} onClick={() => { setStart(Number((duration / 2).toFixed(2))); setEnd(duration); reset(); }}>只保留后半段</button>
        <button type="button" disabled={busy || !video.current} onClick={() => { setStart(Number((video.current?.currentTime ?? 0).toFixed(2))); reset(); }}>从当前播放位置开始</button></div>
      <p className="video-trim-hint">原视频 {duration.toFixed(2)} 秒 · 将保留 {Math.max(0, end - start).toFixed(2)} 秒。原视频和图片会保留。</p></>}
    {error && <p role="alert" className="video-trim-error">{error}</p>}
    {result && <div className="video-trim-result"><h4>裁剪版预览</h4><video controls playsInline src={result.url} /><p>确认画面和声音后采用此版本。其他视频将取消选择，原文件保留。</p></div>}
    <footer><span>{busy ? `正在处理${result ? '并保存' : ` · ${Math.round(progress * 100)}%`}，请保持页面在前台` : '在浏览器中裁剪，不调用视频生成模型'}</span>
      {result ? <button type="button" className="primary" disabled={busy} onClick={save}>采用裁剪版</button>
        : <button type="button" className="primary" disabled={busy || !source || !duration} onClick={generate}>裁剪并预览</button>}</footer>
  </section>;
}
