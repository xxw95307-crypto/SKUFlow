import type { EvidenceLocator, EvidenceSourceKind, FactValue } from './product-passport';

export interface ExtractionEvidenceItem {
  ref: string;
  fileId: string;
  filename: string;
  sourceKind: EvidenceSourceKind;
  locator: EvidenceLocator;
  excerpt: string;
  contentHash: string;
}

export interface ExtractedCandidate {
  value: FactValue;
  unit: string | null;
  confidence: number;
  evidenceRefs: string[];
}

export interface ExtractedFact extends ExtractedCandidate {
  key: string;
  label: string;
  alternatives: ExtractedCandidate[];
}

export interface FactExtractionOutput {
  facts: ExtractedFact[];
  notes: string[];
}

export interface FactExtractionSummary {
  factsExtracted: number;
  confirmedPreserved: number;
  missing: number;
  conflicts: number;
  evidenceCreated: number;
  imageBlocksPending: number;
  model: string;
}

export type AgentRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface AgentRun {
  id: string;
  taskId: string;
  passportId: string;
  provider: 'BAILIAN';
  model: string;
  promptVersion: string;
  status: AgentRunStatus;
  inputHash: string;
  result: FactExtractionOutput | null;
  usage: Record<string, number> | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
