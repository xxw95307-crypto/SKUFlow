const MARKET_LOCALES: Record<string, { locale: string; language: string }> = {
  '美国': { locale: 'en-US', language: '英语（美国）' }, US: { locale: 'en-US', language: '英语（美国）' },
  '英国': { locale: 'en-GB', language: '英语（英国）' }, UK: { locale: 'en-GB', language: '英语（英国）' },
  '德国': { locale: 'de-DE', language: '德语' }, DE: { locale: 'de-DE', language: '德语' },
  '日本': { locale: 'ja-JP', language: '日语' }, JP: { locale: 'ja-JP', language: '日语' },
  '新加坡': { locale: 'en-SG', language: '英语（新加坡）' }, SG: { locale: 'en-SG', language: '英语（新加坡）' },
  '巴西': { locale: 'pt-BR', language: '葡萄牙语（巴西）' }, BR: { locale: 'pt-BR', language: '葡萄牙语（巴西）' },
  '中国': { locale: 'zh-CN', language: '简体中文' }, CN: { locale: 'zh-CN', language: '简体中文' },
};

export function marketLocale(market: string): { locale: string; language: string } {
  return MARKET_LOCALES[market.trim()] ?? { locale: 'en-US', language: '英语（美国）' };
}

export function isChineseLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh');
}
