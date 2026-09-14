import { validateVideoTrimRange } from '../domain/video-trim';

// Decode and record only the selected segment. No microphone, screen recording,
// remote editing service, or generative model is involved.
export async function trimVideo(input: HTMLVideoElement, start: number, end: number, onProgress: (value: number) => void): Promise<Blob> {
  validateVideoTrimRange(start, end, Number.isFinite(input.duration) ? input.duration : end);
  if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持视频裁剪，请使用新版 Chrome 或 Edge');
  const mime = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus']
    .find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) throw new Error('当前浏览器没有可用的视频编码器，请使用新版 Chrome 或 Edge');
  // Each attempt needs its own element: a MediaElementAudioSourceNode cannot be
  // attached twice to the same element, including after closing its context.
  const video = document.createElement('video');
  video.playsInline = true; video.preload = 'auto'; video.src = input.currentSrc;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('原视频加载超时')); }, 15000);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('原视频无法读取')); };
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('loadeddata', done); video.removeEventListener('error', fail); };
    video.addEventListener('loadeddata', done); video.addEventListener('error', fail); video.load();
  });
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context || !canvas.width || !canvas.height) throw new Error('请等待原视频加载完成');
  const stream = canvas.captureStream(30);
  const audio = new AudioContext();
  const output = audio.createMediaStreamDestination();
  const source = audio.createMediaElementSource(video);
  source.connect(output);
  output.stream.getAudioTracks().forEach(track => stream.addTrack(track));
  let frame = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await audio.resume();
    video.pause(); video.muted = false; video.playbackRate = 1;
    if (Math.abs(video.currentTime - start) > 0.001) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('视频定位超时')); }, 15000);
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error('原视频无法读取')); };
        const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', fail); };
        video.addEventListener('seeked', done); video.addEventListener('error', fail); video.currentTime = start;
      });
    }
    context.drawImage(video, 0, 0);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    return await new Promise<Blob>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => { if (settled) return; settled = true; if (recorder.state !== 'inactive') recorder.stop(); reject(error); };
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => fail(new Error('裁剪编码失败，请重试'));
      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        const blob = new Blob(chunks, { type: mime.startsWith('video/mp4') ? 'video/mp4' : 'video/webm' });
        if (!blob.size) reject(new Error('裁剪未产生视频文件')); else resolve(blob);
      };
      const draw = () => {
        context.drawImage(video, 0, 0);
        onProgress(Math.min(1, (video.currentTime - start) / (end - start)));
        if (video.currentTime >= end || video.ended) { video.pause(); if (recorder.state !== 'inactive') recorder.stop(); }
        else frame = requestAnimationFrame(draw);
      };
      timeout = setTimeout(() => fail(new Error('裁剪超时，请保持此页面在前台后重试')), (end - start + 30) * 1000);
      recorder.start(250);
      video.play().then(draw).catch(() => fail(new Error('视频播放失败，请重试')));
    });
  } finally {
    video.pause(); cancelAnimationFrame(frame); clearTimeout(timeout);
    stream.getTracks().forEach(track => track.stop()); source.disconnect(); await audio.close();
    video.removeAttribute('src'); video.load();
  }
}
