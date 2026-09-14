export interface VideoTrimRange { start: number; end: number }

export function validateVideoTrimRange(start: unknown, end: unknown, duration: number): VideoTrimRange {
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
    || !Number.isFinite(duration) || duration <= 0 || start < 0 || end > duration + 0.05 || end - start < 0.25) {
    throw new Error('请选择有效的保留时段：起点不能小于 0，终点不能超过视频时长，至少保留 0.25 秒');
  }
  return { start, end: Math.min(end, duration) };
}

export function videoMediaType(plan: { contentType?: unknown }): 'video/mp4' | 'video/webm' {
  return plan.contentType === 'video/webm' ? 'video/webm' : 'video/mp4';
}

export function isVideoContainer(bytes: Uint8Array, type: string): boolean {
  return type === 'video/mp4'
    ? bytes.length > 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp'
    : type === 'video/webm' && bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}
