export type PlatformId =
  | 'amazon'
  | 'tiktok-shop'
  | 'shopify'
  | 'shopee'
  | 'lazada'
  | 'ebay'
  | 'walmart'
  | 'etsy'
  | 'aliexpress'
  | 'temu'
  | 'mercado-libre'
  | 'woocommerce';

export type PlatformFamily =
  | 'marketplace'
  | 'social-commerce'
  | 'dtc'
  | 'regional-marketplace';

export type PlatformSupportLevel =
  | 'planned'
  | 'content'
  | 'validated-export'
  | 'sandbox'
  | 'live-draft';

export interface PlatformProfile {
  id: PlatformId;
  name: string;
  shortName: string;
  family: PlatformFamily;
  regions: string[];
  supportLevel: PlatformSupportLevel;
  adapterVersion: string;
  capabilities: {
    contentGeneration: boolean;
    schemaValidation: boolean;
    fileExport: boolean;
    sandbox: boolean;
    draftPublishing: boolean;
  };
}
