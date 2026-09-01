export type FactStatus = 'CONFIRMED' | 'EXTRACTED' | 'CONFLICT' | 'MISSING';

export interface EvidencePointer {
  fileId: string;
  locator: string;
  excerpt?: string;
}

export interface ProductFact<T = string | number | boolean> {
  key: string;
  label: string;
  value: T | null;
  unit?: string;
  status: FactStatus;
  confidence: number | null;
  evidence: EvidencePointer[];
}

export interface ProductVariant {
  sku: string;
  attributes: Record<string, string>;
  facts: ProductFact[];
}

export interface ProductPassport {
  id: string;
  taskId: string;
  version: number;
  productName: ProductFact<string>;
  brand: ProductFact<string>;
  categoryHint: ProductFact<string>;
  facts: ProductFact[];
  variants: ProductVariant[];
  lockedAt: string | null;
}
