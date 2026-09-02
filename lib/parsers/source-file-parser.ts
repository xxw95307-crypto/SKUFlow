import { extractText } from 'unpdf';
import * as XLSX from 'xlsx';
import type {
  ParsedBlock,
  ParsedImageBlock,
  ParsedTableBlock,
  ParsedTextBlock,
  ParserKind,
  UnifiedParseResult,
} from '../domain/document-parsing';

const MAX_TEXT_CHARACTERS = 120_000;
const MAX_TEXT_BLOCKS = 200;
const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 200;
const MAX_COLUMNS = 50;

export interface SourceFileInput {
  taskId: string;
  fileId: string;
  filename: string;
  contentType: string;
  bytes: ArrayBuffer | Uint8Array;
  resultId?: string;
  now?: string;
}

interface ParsedPayload {
  text: string;
  blocks: ParsedBlock[];
  metadata: Partial<UnifiedParseResult['metadata']>;
  warnings: string[];
}

function extensionOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

export function classifyParser(filename: string, contentType: string): ParserKind {
  const extension = extensionOf(filename);
  const mime = contentType.toLowerCase();
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp'].includes(extension)) return 'IMAGE';
  if (mime === 'application/pdf' || extension === 'pdf') return 'PDF';
  if (
    ['xlsx', 'xls', 'csv'].includes(extension)
    || mime.includes('spreadsheet')
    || mime.includes('excel')
    || mime === 'text/csv'
  ) return 'SPREADSHEET';
  if (mime.startsWith('text/') || ['txt', 'md', 'json', 'xml', 'yaml', 'yml'].includes(extension)) return 'TEXT';
  return 'UNSUPPORTED';
}

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

function normalizeText(value: string): string {
  return value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
}

function limitText(value: string, warnings: string[]): string {
  if (value.length <= MAX_TEXT_CHARACTERS) return value;
  warnings.push(`文本超过 ${MAX_TEXT_CHARACTERS.toLocaleString()} 字符，统一结果已截断`);
  return value.slice(0, MAX_TEXT_CHARACTERS);
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(bytes.subarray(start));
}

function textBlocks(text: string, sourceRef: string): ParsedTextBlock[] {
  if (!text) return [];
  const lines = text.split('\n');
  const blocks: ParsedTextBlock[] = [];
  for (let index = 0; index < lines.length && blocks.length < MAX_TEXT_BLOCKS; index += 40) {
    const chunk = lines.slice(index, index + 40).join('\n').trim();
    if (!chunk) continue;
    blocks.push({
      id: `block_${blocks.length + 1}`,
      type: 'text',
      text: chunk,
      locator: { sourceRef, lineStart: index + 1, lineEnd: Math.min(index + 40, lines.length) },
    });
  }
  return blocks;
}

function parseTextFile(bytes: Uint8Array, fileId: string): ParsedPayload {
  const warnings: string[] = [];
  const text = limitText(normalizeText(decodeText(bytes)), warnings);
  if (!text) warnings.push('文本文件没有可提取内容');
  return { text, blocks: textBlocks(text, fileId), metadata: {}, warnings };
}

async function parsePdfFile(bytes: Uint8Array, fileId: string): Promise<ParsedPayload> {
  const warnings: string[] = [];
  const extracted = await extractText(bytes.slice(), { mergePages: false });
  const pageTexts = extracted.text.map((page) => normalizeText(page));
  let text = limitText(pageTexts.filter(Boolean).join('\n\n'), warnings);
  const blocks: ParsedTextBlock[] = [];
  let usedCharacters = 0;

  for (let index = 0; index < pageTexts.length && blocks.length < MAX_TEXT_BLOCKS; index += 1) {
    if (!pageTexts[index]) continue;
    const remaining = MAX_TEXT_CHARACTERS - usedCharacters;
    if (remaining <= 0) break;
    const pageText = pageTexts[index].slice(0, remaining);
    usedCharacters += pageText.length;
    blocks.push({
      id: `block_${blocks.length + 1}`,
      type: 'text',
      text: pageText,
      locator: { sourceRef: fileId, page: index + 1 },
    });
  }

  if (!text) {
    text = '';
    warnings.push('PDF 没有可提取文本，可能是扫描件；文件仍可在 Day 4 进入视觉识别');
  }
  if (extracted.totalPages > MAX_TEXT_BLOCKS) warnings.push(`PDF 共 ${extracted.totalPages} 页，仅保留前 ${MAX_TEXT_BLOCKS} 个非空页面块`);
  return { text, blocks, metadata: { pageCount: extracted.totalPages }, warnings };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseSpreadsheetFile(bytes: Uint8Array, fileId: string): ParsedPayload {
  const warnings: string[] = [];
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true, dense: true, sheetRows: MAX_ROWS_PER_SHEET + 1 });
  const sheetNames = workbook.SheetNames.slice(0, MAX_SHEETS);
  const blocks: ParsedTableBlock[] = [];
  const textParts: string[] = [];
  let truncated = workbook.SheetNames.length > MAX_SHEETS;

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false,
    });
    const rows = rawRows.slice(0, MAX_ROWS_PER_SHEET).map((row) => row.slice(0, MAX_COLUMNS).map(cellText));
    if (rawRows.length > MAX_ROWS_PER_SHEET || rows.some((row) => row.length >= MAX_COLUMNS)) truncated = true;
    if (rows.length === 0) continue;
    const headers = rows[0].map((value, index) => value || `Column ${index + 1}`);
    const body = rows.slice(1);
    blocks.push({
      id: `block_${blocks.length + 1}`,
      type: 'table',
      headers,
      rows: body,
      locator: { sourceRef: fileId, sheet: sheetName, range: sheet['!ref'] ?? undefined },
    });
    textParts.push(`[Sheet: ${sheetName}]`, ...rows.map((row) => row.join('\t')));
  }

  if (truncated) warnings.push(`工作簿预览限制为 ${MAX_SHEETS} 个工作表、每表 ${MAX_ROWS_PER_SHEET} 行 × ${MAX_COLUMNS} 列`);
  if (blocks.length === 0) warnings.push('工作簿没有可读取的单元格');
  const text = limitText(normalizeText(textParts.join('\n')), warnings);
  return { text, blocks, metadata: { sheetNames: workbook.SheetNames, truncated }, warnings };
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function imageDimensions(bytes: Uint8Array, extension: string): { width: number | null; height: number | null; format: string } {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20), format: 'PNG' };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return {
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
          format: 'JPEG',
        };
      }
      const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (segmentLength < 2) break;
      offset += segmentLength + 2;
    }
    return { width: null, height: null, format: 'JPEG' };
  }

  const riff = String.fromCharCode(...bytes.subarray(0, 4));
  const webp = String.fromCharCode(...bytes.subarray(8, 12));
  if (bytes.length >= 30 && riff === 'RIFF' && webp === 'WEBP') {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === 'VP8X') return { width: readUint24LE(bytes, 24) + 1, height: readUint24LE(bytes, 27) + 1, format: 'WEBP' };
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      return {
        width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
        height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6)),
        format: 'WEBP',
      };
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: ((bytes[27] << 8) | bytes[26]) & 0x3fff, height: ((bytes[29] << 8) | bytes[28]) & 0x3fff, format: 'WEBP' };
    }
    return { width: null, height: null, format: 'WEBP' };
  }

  return { width: null, height: null, format: extension.toUpperCase() || 'IMAGE' };
}

function parseImageFile(bytes: Uint8Array, fileId: string, filename: string): ParsedPayload {
  const warnings: string[] = [];
  const dimensions = imageDimensions(bytes, extensionOf(filename));
  if (dimensions.width === null || dimensions.height === null) warnings.push('已识别图片格式，但未能读取像素尺寸');
  const block: ParsedImageBlock = {
    id: 'block_1',
    type: 'image',
    format: dimensions.format,
    width: dimensions.width,
    height: dimensions.height,
    altText: null,
    locator: { sourceRef: fileId },
  };
  return {
    text: '',
    blocks: [block],
    metadata: { width: dimensions.width, height: dimensions.height },
    warnings,
  };
}

export async function parseSourceFile(input: SourceFileInput): Promise<UnifiedParseResult> {
  const startedAt = input.now ?? new Date().toISOString();
  const bytes = toBytes(input.bytes);
  const contentHash = await sha256(bytes);
  const parserKind = classifyParser(input.filename, input.contentType);
  if (parserKind === 'UNSUPPORTED') throw new Error(`暂不支持解析此文件类型：${extensionOf(input.filename) || input.contentType}`);

  let payload: ParsedPayload;
  if (parserKind === 'TEXT') payload = parseTextFile(bytes, input.fileId);
  else if (parserKind === 'PDF') payload = await parsePdfFile(bytes, input.fileId);
  else if (parserKind === 'SPREADSHEET') payload = parseSpreadsheetFile(bytes, input.fileId);
  else payload = parseImageFile(bytes, input.fileId, input.filename);

  const completedAt = input.now ?? new Date().toISOString();
  return {
    id: input.resultId ?? `parse_${crypto.randomUUID()}`,
    schemaVersion: '1.0',
    taskId: input.taskId,
    fileId: input.fileId,
    filename: input.filename,
    contentType: input.contentType,
    parserKind,
    status: payload.warnings.length > 0 ? 'PARTIAL' : 'COMPLETED',
    text: payload.text,
    blocks: payload.blocks,
    metadata: {
      byteSize: bytes.byteLength,
      sha256: contentHash,
      characterCount: payload.text.length,
      blockCount: payload.blocks.length,
      ...payload.metadata,
    },
    warnings: payload.warnings,
    error: null,
    startedAt,
    completedAt,
  };
}

export async function createFailedParseResult(input: SourceFileInput, error: unknown): Promise<UnifiedParseResult> {
  const bytes = toBytes(input.bytes);
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.resultId ?? `parse_${crypto.randomUUID()}`,
    schemaVersion: '1.0',
    taskId: input.taskId,
    fileId: input.fileId,
    filename: input.filename,
    contentType: input.contentType,
    parserKind: classifyParser(input.filename, input.contentType),
    status: 'FAILED',
    text: '',
    blocks: [],
    metadata: {
      byteSize: bytes.byteLength,
      sha256: await sha256(bytes),
      characterCount: 0,
      blockCount: 0,
    },
    warnings: [],
    error: error instanceof Error ? error.message.slice(0, 500) : '文件解析失败',
    startedAt: now,
    completedAt: now,
  };
}
