import type { PlatformTarget } from '../platforms/market-options.ts';
import { validatePlatformTargets } from '../platforms/market-options.ts';

export interface ShopPreferences {
  brandVoice: string;
  bannedWords: string[];
  preferredTargets: PlatformTarget[];
  visualStyle: string;
  confirmedAt: string;
}

function shortText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label}格式不正确`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 字`);
  return text;
}

export function parseShopPreferences(value: unknown, confirmedAt = new Date().toISOString()): ShopPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('店铺偏好格式不正确');
  const input = value as Record<string, unknown>;
  const brandVoice = shortText(input.brandVoice, '品牌语气', 300);
  const visualStyle = shortText(input.visualStyle, '视觉偏好', 300);
  if (!Array.isArray(input.bannedWords) || input.bannedWords.length > 30) throw new Error('禁用词最多 30 个');
  const bannedWords = [...new Set(input.bannedWords.map((word) => shortText(word, '禁用词', 40)).filter(Boolean))];
  if (!Array.isArray(input.preferredTargets) || input.preferredTargets.length > 30) throw new Error('常用站点最多 30 个');
  const preferredTargets = input.preferredTargets.length
    ? validatePlatformTargets(input.preferredTargets as PlatformTarget[])
    : [];
  return { brandVoice, bannedWords, preferredTargets, visualStyle, confirmedAt };
}

export function removeBannedWords(value: unknown, bannedWords: readonly string[]): unknown {
  if (typeof value === 'string') {
    return bannedWords.reduce((text, word) => word ? text.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), '') : text, value)
      .replace(/\s{2,}/g, ' ').trim();
  }
  if (Array.isArray(value)) return value.map((item) => removeBannedWords(item, bannedWords));
  return value;
}
