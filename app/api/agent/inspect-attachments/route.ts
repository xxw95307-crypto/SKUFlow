import { withAuthentication } from '@/lib/server/auth';
import { getBindings } from '@/db/client';
import { callBailianVisionAnalysis } from '@/lib/ai/bailian-client';
import { loadBailianConfig, missingBailianConfig } from '@/lib/config/bailian';
import { parseSourceFile } from '@/lib/parsers/source-file-parser';

export const dynamic = 'force-dynamic';

const MAX_FILES = 12;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_RESULT_CHARACTERS = 6_500;

interface AttachmentInspection {
  filename: string;
  contentType: string;
  kind: string;
  summary: string;
  extractedText: string;
  warnings: string[];
}

function capText(value: string, remaining: number): string {
  if (remaining <= 0) return '';
  return value.length <= remaining ? value : `${value.slice(0, Math.max(0, remaining - 12))}\n[内容已截断]`;
}

async function handlePOST(request: Request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((item): item is File => item instanceof File);
    if (files.length === 0) return Response.json({ error: '没有收到可读取的附件' }, { status: 400 });
    if (files.length > MAX_FILES) return Response.json({ error: `一次最多读取 ${MAX_FILES} 个附件` }, { status: 400 });
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) return Response.json({ error: '附件总大小不能超过 40 MB' }, { status: 413 });

    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    const config = imageFiles.length > 0 ? loadBailianConfig(getBindings()) : null;
    const missing = config ? missingBailianConfig(config) : [];
    const inspections: AttachmentInspection[] = [];
    let remainingCharacters = MAX_RESULT_CHARACTERS;

    for (const [index, file] of files.entries()) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (file.type.startsWith('image/')) {
          if (!config || missing.length > 0) throw new Error(`图片理解不可用，百炼配置缺少：${missing.join(', ')}`);
          const vision = await callBailianVisionAnalysis(config, {
            bytes,
            contentType: file.type,
            filename: file.name,
            productName: null,
          });
          const facts = vision.output.facts.map((fact) => `${fact.label}：${typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)}`).join('；');
          const extracted = capText([vision.output.visibleText && `可见文字：${vision.output.visibleText}`, facts && `可见属性：${facts}`].filter(Boolean).join('\n'), remainingCharacters);
          remainingCharacters -= extracted.length;
          inspections.push({
            filename: file.name,
            contentType: file.type,
            kind: 'IMAGE',
            summary: vision.output.summary || '图片已完成视觉理解',
            extractedText: extracted,
            warnings: vision.output.warnings,
          });
          continue;
        }

        const parsed = await parseSourceFile({
          taskId: 'chat_attachment',
          fileId: `attachment_${index + 1}`,
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          bytes,
        });
        const extracted = capText(parsed.text, remainingCharacters);
        remainingCharacters -= extracted.length;
        inspections.push({
          filename: file.name,
          contentType: file.type,
          kind: parsed.parserKind,
          summary: `${parsed.metadata.blockCount} 个内容块，${parsed.metadata.characterCount} 个字符`,
          extractedText: extracted,
          warnings: parsed.warnings,
        });
      } catch (error) {
        inspections.push({
          filename: file.name,
          contentType: file.type,
          kind: file.type.startsWith('image/') ? 'IMAGE' : 'UNSUPPORTED',
          summary: '附件读取失败',
          extractedText: '',
          warnings: [error instanceof Error ? error.message : '附件读取失败'],
        });
      }
    }

    return Response.json({
      inspected: inspections.filter((item) => item.summary !== '附件读取失败').length,
      total: files.length,
      attachments: inspections,
      note: '这些附件只用于回答当前问题，尚未创建商品上新任务。',
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '附件读取失败' }, { status: 500 });
  }
}

export const POST = withAuthentication(handlePOST);
