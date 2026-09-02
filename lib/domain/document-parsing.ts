export const PARSER_KINDS = ['IMAGE', 'PDF', 'SPREADSHEET', 'TEXT', 'UNSUPPORTED'] as const;
export type ParserKind = (typeof PARSER_KINDS)[number];

export const PARSE_STATUSES = ['COMPLETED', 'PARTIAL', 'FAILED'] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];

export interface ParseLocator {
  page?: number;
  sheet?: string;
  range?: string;
  lineStart?: number;
  lineEnd?: number;
  sourceRef?: string;
}

export interface ParsedTextBlock {
  id: string;
  type: 'text';
  text: string;
  locator: ParseLocator;
}

export interface ParsedTableBlock {
  id: string;
  type: 'table';
  headers: string[];
  rows: string[][];
  locator: ParseLocator;
}

export interface ParsedImageBlock {
  id: string;
  type: 'image';
  format: string;
  width: number | null;
  height: number | null;
  altText: string | null;
  locator: ParseLocator;
}

export type ParsedBlock = ParsedTextBlock | ParsedTableBlock | ParsedImageBlock;

export interface ParseMetadata {
  byteSize: number;
  sha256: string;
  characterCount: number;
  blockCount: number;
  pageCount?: number;
  sheetNames?: string[];
  width?: number | null;
  height?: number | null;
  truncated?: boolean;
}

export interface UnifiedParseResult {
  id: string;
  schemaVersion: '1.0';
  taskId: string;
  fileId: string;
  filename: string;
  contentType: string;
  parserKind: ParserKind;
  status: ParseStatus;
  text: string;
  blocks: ParsedBlock[];
  metadata: ParseMetadata;
  warnings: string[];
  error: string | null;
  startedAt: string;
  completedAt: string;
}

export interface ParseSummary {
  total: number;
  completed: number;
  partial: number;
  failed: number;
  textCharacters: number;
  blocks: number;
}

export function summarizeParseResults(results: UnifiedParseResult[]): ParseSummary {
  return results.reduce<ParseSummary>((summary, result) => ({
    total: summary.total + 1,
    completed: summary.completed + (result.status === 'COMPLETED' ? 1 : 0),
    partial: summary.partial + (result.status === 'PARTIAL' ? 1 : 0),
    failed: summary.failed + (result.status === 'FAILED' ? 1 : 0),
    textCharacters: summary.textCharacters + result.metadata.characterCount,
    blocks: summary.blocks + result.metadata.blockCount,
  }), { total: 0, completed: 0, partial: 0, failed: 0, textCharacters: 0, blocks: 0 });
}
