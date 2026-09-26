import type { PlatformId, PlatformProfile } from '../domain/platform';

export const platformRegistry: readonly PlatformProfile[] = [
  { id: 'amazon', name: 'Amazon', shortName: 'Amazon', family: 'marketplace', regions: ['NA', 'EU', 'FE'], supportLevel: 'sandbox', adapterVersion: '0.2.0', capabilities: { contentGeneration: true, schemaValidation: false, fileExport: true, sandbox: true, draftPublishing: false } },
  { id: 'tiktok-shop', name: 'TikTok Shop', shortName: 'TikTok', family: 'social-commerce', regions: ['US', 'UK', 'SEA'], supportLevel: 'content', adapterVersion: '0.1.0', capabilities: { contentGeneration: true, schemaValidation: false, fileExport: true, sandbox: false, draftPublishing: false } },
  { id: 'shopify', name: 'Shopify', shortName: 'Shopify', family: 'dtc', regions: ['Global'], supportLevel: 'sandbox', adapterVersion: '0.2.0', capabilities: { contentGeneration: true, schemaValidation: true, fileExport: true, sandbox: true, draftPublishing: true } },
  { id: 'shopee', name: 'Shopee', shortName: 'Shopee', family: 'regional-marketplace', regions: ['SEA', 'TW', 'BR'], supportLevel: 'content', adapterVersion: '0.1.0', capabilities: { contentGeneration: true, schemaValidation: false, fileExport: true, sandbox: false, draftPublishing: false } },
  { id: 'lazada', name: 'Lazada', shortName: 'Lazada', family: 'regional-marketplace', regions: ['SEA'], supportLevel: 'planned', adapterVersion: '0.1.0', capabilities: { contentGeneration: false, schemaValidation: false, fileExport: false, sandbox: false, draftPublishing: false } },
  { id: 'ebay', name: 'eBay', shortName: 'eBay', family: 'marketplace', regions: ['US', 'UK', 'EU', 'AU'], supportLevel: 'planned', adapterVersion: '0.1.0', capabilities: { contentGeneration: false, schemaValidation: false, fileExport: false, sandbox: false, draftPublishing: false } },
  { id: 'walmart', name: 'Walmart Marketplace', shortName: 'Walmart', family: 'marketplace', regions: ['US', 'CA', 'MX'], supportLevel: 'planned', adapterVersion: '0.1.0', capabilities: { contentGeneration: false, schemaValidation: false, fileExport: false, sandbox: false, draftPublishing: false } },
  { id: 'etsy', name: 'Etsy', shortName: 'Etsy', family: 'marketplace', regions: ['Global'], supportLevel: 'planned', adapterVersion: '0.1.0', capabilities: { contentGeneration: false, schemaValidation: false, fileExport: false, sandbox: false, draftPublishing: false } },
  { id: 'aliexpress', name: 'AliExpress', shortName: 'AliExpress', family: 'marketplace', regions: ['Global'], supportLevel: 'planned', adapterVersion: '0.1.0', capabilities: { contentGeneration: false, schemaValidation: false, fileExport: false, sandbox: false, draftPublishing: false } },
  { id: 'temu', name: 'Temu', shortName: 'Temu', family: 'marketplace', regions: ['Global'], supportLevel: 'planned', adapterVersion: '0.1.0', capabilities: { contentGeneration: false, schemaValidation: false, fileExport: false, sandbox: false, draftPublishing: false } },
  { id: 'mercado-libre', name: 'Mercado Libre', shortName: 'Mercado Libre', family: 'regional-marketplace', regions: ['LATAM'], supportLevel: 'planned', adapterVersion: '0.1.0', capabilities: { contentGeneration: false, schemaValidation: false, fileExport: false, sandbox: false, draftPublishing: false } },
  { id: 'woocommerce', name: 'WooCommerce', shortName: 'WooCommerce', family: 'dtc', regions: ['Global'], supportLevel: 'planned', adapterVersion: '0.1.0', capabilities: { contentGeneration: false, schemaValidation: false, fileExport: false, sandbox: false, draftPublishing: false } },
] as const;

export const defaultPlatformIds: PlatformId[] = ['amazon', 'tiktok-shop', 'shopify', 'shopee'];

export function getPlatformProfile(id: PlatformId): PlatformProfile {
  const profile = platformRegistry.find((platform) => platform.id === id);
  if (!profile) throw new Error(`Unknown platform: ${id}`);
  return profile;
}
