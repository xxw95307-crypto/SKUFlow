import type { AgentRunStatus } from './fact-extraction';
import type { FactValue } from './product-passport';

export type NormalizedImageBox = [number, number, number, number];

export interface VisionFactObservation {
  key: string;
  label: string;
  value: Exclude<FactValue, null>;
  unit: string | null;
  confidence: number;
  bbox: NormalizedImageBox | null;
}

export interface VisionAnalysisOutput {
  summary: string;
  visibleText: string;
  facts: VisionFactObservation[];
  warnings: string[];
}

export interface VisionAgentRun {
  id: string;
  taskId: string;
  passportId: string;
  fileId: string;
  provider: 'BAILIAN';
  model: string;
  promptVersion: string;
  status: AgentRunStatus;
  inputHash: string;
  result: VisionAnalysisOutput | null;
  usage: Record<string, number> | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface VisionAnalysisSummary {
  totalImages: number;
  completed: number;
  failed: number;
  pending: number;
  factsObserved: number;
  visibleTextCharacters: number;
}
