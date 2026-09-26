import { findAmazonMarket } from '../platforms/amazon-markets.ts';

const MARKET_LOCALES: Record<string, { locale: string; language: string }> = {
  '美国': { locale: 'en-US', language: '英语（美国）' }, US: { locale: 'en-US', language: '英语（美国）' },
  '英国': { locale: 'en-GB', language: '英语（英国）' }, UK: { locale: 'en-GB', language: '英语（英国）' },
  '德国': { locale: 'de-DE', language: '德语' }, DE: { locale: 'de-DE', language: '德语' },
  '日本': { locale: 'ja-JP', language: '日语' }, JP: { locale: 'ja-JP', language: '日语' },
  '新加坡': { locale: 'en-SG', language: '英语（新加坡）' }, SG: { locale: 'en-SG', language: '英语（新加坡）' },
  '巴西': { locale: 'pt-BR', language: '葡萄牙语（巴西）' }, BR: { locale: 'pt-BR', language: '葡萄牙语（巴西）' },
  '马来西亚': { locale: 'ms-MY', language: '马来语' }, MY: { locale: 'ms-MY', language: '马来语' },
  '泰国': { locale: 'th-TH', language: '泰语' }, TH: { locale: 'th-TH', language: '泰语' },
  '越南': { locale: 'vi-VN', language: '越南语' }, VN: { locale: 'vi-VN', language: '越南语' },
  '菲律宾': { locale: 'fil-PH', language: '菲律宾语' }, PH: { locale: 'fil-PH', language: '菲律宾语' },
  '印度尼西亚': { locale: 'id-ID', language: '印尼语' }, ID: { locale: 'id-ID', language: '印尼语' },
  '中国台湾': { locale: 'zh-TW', language: '繁体中文' }, TW: { locale: 'zh-TW', language: '繁体中文' },
  '中国': { locale: 'zh-CN', language: '简体中文' }, CN: { locale: 'zh-CN', language: '简体中文' },
};

export function marketLocale(market: string): { locale: string; language: string } {
  const amazon = findAmazonMarket(market);
  return amazon ? { locale: amazon.locale, language: amazon.language } : MARKET_LOCALES[market.trim()] ?? { locale: 'en-US', language: '英语（美国）' };
}

export function marketCurrency(market: string): string | null {
  const amazon = findAmazonMarket(market);
  if (amazon) return amazon.currency;
  const regional: Record<string, string> = {
    马来西亚: 'MYR', 泰国: 'THB', 越南: 'VND', 菲律宾: 'PHP', 印度尼西亚: 'IDR', 中国台湾: 'TWD',
  };
  return regional[market.trim()] ?? null;
}

export function isChineseLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh');
}
