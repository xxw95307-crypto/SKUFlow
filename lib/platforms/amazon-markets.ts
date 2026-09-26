/** Amazon store identifiers and regional sandbox endpoints from SP-API documentation. */
export interface AmazonMarket {
  code: string;
  label: string;
  marketplaceId: string;
  region: 'na' | 'eu' | 'fe';
  locale: string;
  language: string;
  currency: string;
}

export const amazonMarkets: readonly AmazonMarket[] = [
  { code: 'US', label: '美国', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en-US', language: '英语（美国）', currency: 'USD' },
  { code: 'CA', label: '加拿大', marketplaceId: 'A2EUQ1WTGCTBG2', region: 'na', locale: 'en-CA', language: '英语（加拿大）', currency: 'CAD' },
  { code: 'MX', label: '墨西哥', marketplaceId: 'A1AM78C64UM0Y8', region: 'na', locale: 'es-MX', language: '西班牙语（墨西哥）', currency: 'MXN' },
  { code: 'BR', label: '巴西', marketplaceId: 'A2Q3Y263D00KWC', region: 'na', locale: 'pt-BR', language: '葡萄牙语（巴西）', currency: 'BRL' },
  { code: 'IE', label: '爱尔兰', marketplaceId: 'A28R8C7NBKEWEA', region: 'eu', locale: 'en-IE', language: '英语（爱尔兰）', currency: 'EUR' },
  { code: 'ES', label: '西班牙', marketplaceId: 'A1RKKUPIHCS9HS', region: 'eu', locale: 'es-ES', language: '西班牙语', currency: 'EUR' },
  { code: 'UK', label: '英国', marketplaceId: 'A1F83G8C2ARO7P', region: 'eu', locale: 'en-GB', language: '英语（英国）', currency: 'GBP' },
  { code: 'FR', label: '法国', marketplaceId: 'A13V1IB3VIYZZH', region: 'eu', locale: 'fr-FR', language: '法语', currency: 'EUR' },
  { code: 'BE', label: '比利时', marketplaceId: 'AMEN7PMS3EDWL', region: 'eu', locale: 'nl-BE', language: '荷兰语（比利时）', currency: 'EUR' },
  { code: 'NL', label: '荷兰', marketplaceId: 'A1805IZSGTT6HS', region: 'eu', locale: 'nl-NL', language: '荷兰语', currency: 'EUR' },
  { code: 'DE', label: '德国', marketplaceId: 'A1PA6795UKMFR9', region: 'eu', locale: 'de-DE', language: '德语', currency: 'EUR' },
  { code: 'IT', label: '意大利', marketplaceId: 'APJ6JRA9NG5V4', region: 'eu', locale: 'it-IT', language: '意大利语', currency: 'EUR' },
  { code: 'SE', label: '瑞典', marketplaceId: 'A2NODRKZP88ZB9', region: 'eu', locale: 'sv-SE', language: '瑞典语', currency: 'SEK' },
  { code: 'ZA', label: '南非', marketplaceId: 'AE08WJ6YKNBMC', region: 'eu', locale: 'en-ZA', language: '英语（南非）', currency: 'ZAR' },
  { code: 'PL', label: '波兰', marketplaceId: 'A1C3SOZRARQ6R3', region: 'eu', locale: 'pl-PL', language: '波兰语', currency: 'PLN' },
  { code: 'EG', label: '埃及', marketplaceId: 'ARBP9OOSHTCHU', region: 'eu', locale: 'ar-EG', language: '阿拉伯语（埃及）', currency: 'EGP' },
  { code: 'TR', label: '土耳其', marketplaceId: 'A33AVAJ2PDY3EV', region: 'eu', locale: 'tr-TR', language: '土耳其语', currency: 'TRY' },
  { code: 'SA', label: '沙特阿拉伯', marketplaceId: 'A17E79C6D8DWNP', region: 'eu', locale: 'ar-SA', language: '阿拉伯语（沙特）', currency: 'SAR' },
  { code: 'AE', label: '阿联酋', marketplaceId: 'A2VIGQ35RCS4UG', region: 'eu', locale: 'ar-AE', language: '阿拉伯语（阿联酋）', currency: 'AED' },
  { code: 'IN', label: '印度', marketplaceId: 'A21TJRUUN4KGV', region: 'eu', locale: 'en-IN', language: '英语（印度）', currency: 'INR' },
  { code: 'SG', label: '新加坡', marketplaceId: 'A19VAU5U5O7RUS', region: 'fe', locale: 'en-SG', language: '英语（新加坡）', currency: 'SGD' },
  { code: 'AU', label: '澳大利亚', marketplaceId: 'A39IBJ37TRP1C6', region: 'fe', locale: 'en-AU', language: '英语（澳大利亚）', currency: 'AUD' },
  { code: 'JP', label: '日本', marketplaceId: 'A1VC38T7YXB528', region: 'fe', locale: 'ja-JP', language: '日语', currency: 'JPY' },
] as const;

export function findAmazonMarket(value: string): AmazonMarket | null {
  const normalized = value.trim().toUpperCase();
  return amazonMarkets.find((market) => market.code === normalized || market.label === value.trim()) ?? null;
}

export function requireAmazonMarket(value: string): AmazonMarket {
  const market = findAmazonMarket(value);
  if (!market) throw new Error(`暂不支持 Amazon ${value} 站点的沙箱测试`);
  return market;
}

export function amazonSandboxEndpoint(market: AmazonMarket): string {
  return `https://sandbox.sellingpartnerapi-${market.region}.amazon.com`;
}
