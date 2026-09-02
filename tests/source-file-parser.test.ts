import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { classifyParser, parseSourceFile } from '../lib/parsers/source-file-parser.ts';

const baseInput = {
  taskId: 'task_parser',
  resultId: 'parse_test',
  now: '2026-09-03T00:00:00.000Z',
};

function createSimplePdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test('classifies all Day 3 source families', () => {
  assert.equal(classifyParser('photo.webp', 'image/webp'), 'IMAGE');
  assert.equal(classifyParser('manual.pdf', 'application/pdf'), 'PDF');
  assert.equal(classifyParser('spec.xlsx', 'application/octet-stream'), 'SPREADSHEET');
  assert.equal(classifyParser('notes.txt', 'text/plain'), 'TEXT');
  assert.equal(classifyParser('contract.docx', 'application/octet-stream'), 'UNSUPPORTED');
});

test('parses text into bounded unified text blocks', async () => {
  const result = await parseSourceFile({
    ...baseInput,
    fileId: 'file_text',
    filename: 'spec.txt',
    contentType: 'text/plain',
    bytes: new TextEncoder().encode('容量: 380ml\n功率: 70W'),
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.parserKind, 'TEXT');
  assert.match(result.text, /380ml/);
  assert.equal(result.blocks[0].type, 'text');
  assert.equal(result.metadata.blockCount, 1);
});

test('parses workbook sheets and cells into table blocks', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['字段', '值'],
    ['容量', '380 ml'],
    ['功率', '70 W'],
  ]), '参数表');
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const result = await parseSourceFile({
    ...baseInput,
    fileId: 'file_sheet',
    filename: 'spec.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes,
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.blocks[0].type, 'table');
  assert.deepEqual(result.metadata.sheetNames, ['参数表']);
  assert.match(result.text, /380 ml/);
});

test('extracts page text from a PDF', async () => {
  const result = await parseSourceFile({
    ...baseInput,
    fileId: 'file_pdf',
    filename: 'manual.pdf',
    contentType: 'application/pdf',
    bytes: createSimplePdf('Hello PDF'),
  });
  assert.equal(result.parserKind, 'PDF');
  assert.equal(result.metadata.pageCount, 1);
  assert.match(result.text, /Hello PDF/);
  assert.equal(result.blocks[0].type, 'text');
});

test('extracts PNG dimensions into an image block', async () => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  new DataView(bytes.buffer).setUint32(16, 1200);
  new DataView(bytes.buffer).setUint32(20, 800);
  const result = await parseSourceFile({
    ...baseInput,
    fileId: 'file_image',
    filename: 'hero.png',
    contentType: 'image/png',
    bytes,
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.metadata.width, 1200);
  assert.equal(result.metadata.height, 800);
  assert.equal(result.blocks[0].type, 'image');
});
