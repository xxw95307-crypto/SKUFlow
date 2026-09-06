export const GENERATED_ASSET_KINDS = ['HERO', 'LIFESTYLE', 'DETAIL', 'MODEL', 'FEATURE', 'SCALE', 'PACKAGING'] as const;

export type GeneratedAssetKind = (typeof GENERATED_ASSET_KINDS)[number];
export type GeneratedAssetStatus = 'COMPLETED' | 'FAILED';

export interface GeneratedAsset {
  id: string;
  taskId: string;
  sourceFileId: string;
  batchId: string;
  kind: GeneratedAssetKind;
  title: string;
  note: string;
  model: string;
  status: GeneratedAssetStatus;
  width: number | null;
  height: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  imageUrl: string | null;
}

export interface GeneratedAssetSummary {
  total: number;
  completed: number;
  failed: number;
}
