import { buildFactExtractionMessages, parseFactExtractionOutput, type ExtractionContext } from '../agents/fact-extraction.ts';
import { buildVisionAnalysisPrompt, parseVisionAnalysisOutput } from '../agents/vision-analysis.ts';
import { buildListingGenerationMessages, parseListingGenerationOutput, type ListingGenerationContext } from '../agents/listing-generation.ts';
import type { BailianConfig } from '../config/bailian.ts';
import type { FactExtractionOutput } from '../domain/fact-extraction';
import type { VisionAnalysisOutput } from '../domain/vision-analysis';
import type { ListingGenerationOutput } from '../domain/listing';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface BailianFactExtractionResponse {
  output: FactExtractionOutput;
  model: string;
  usage: Record<string, number> | null;
  requestId: string | null;
}

export interface BailianListingGenerationResponse {
  output: ListingGenerationOutput;
  model: string;
  usage: Record<string, number> | null;
  requestId: string | null;
}

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  usage?: Record<string, unknown>;
}

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('BAILIAN_BASE_URL 尚未配置');
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.aliyuncs.com')) {
    throw new Error('百炼 Base URL 必须使用 aliyuncs.com 的 HTTPS 地址');
  }
  return baseUrl;
}

function normalizeUsage(value: Record<string, unknown> | undefined): Record<string, number> | null {
  if (!value) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function responseText(content: string | Array<{ text?: string }> | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => item.text ?? '').join('');
  return '';
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function hashExtractionInput(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function callBailianFactExtraction(
  config: BailianConfig,
  context: ExtractionContext,
  fetchImpl: typeof fetch = fetch,
): Promise<BailianFactExtractionResponse> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error('百炼 API Key 尚未配置');
  if (context.items.length === 0) throw new Error('没有可供文本模型抽取的证据内容');
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = config.model.trim();
  if (!model) throw new Error('BAILIAN_MODEL 尚未配置');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: buildFactExtractionMessages(context),
        response_format: { type: 'json_object' },
        enable_thinking: false,
        temperature: 0.1,
        max_completion_tokens: 4_096,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
      throw new Error(`百炼调用失败（HTTP ${response.status}${requestId ? `，Request ID ${requestId}` : ''}）`);
    }
    const payload = await response.json() as ChatCompletionResponse;
    const content = responseText(payload.choices?.[0]?.message?.content);
    if (!content) throw new Error('百炼返回内容为空');
    return {
      output: parseFactExtractionOutput(content, context.items),
      model: payload.model || model,
      usage: normalizeUsage(payload.usage),
      requestId: payload.id || response.headers.get('x-request-id'),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('百炼调用超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callBailianListingGeneration(
  config: BailianConfig,
  context: ListingGenerationContext,
  fetchImpl: typeof fetch = fetch,
): Promise<BailianListingGenerationResponse> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error('百炼 API Key 尚未配置');
  if (context.drafts.length === 0) throw new Error('没有需要生成的 Listing 草稿');
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = config.model.trim();
  if (!model) throw new Error('BAILIAN_MODEL 尚未配置');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: buildListingGenerationMessages(context),
        response_format: { type: 'json_object' },
        enable_thinking: false,
        temperature: 0.55,
        max_completion_tokens: 8_192,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
      throw new Error(`百炼 Listing 生成失败（HTTP ${response.status}${requestId ? `，Request ID ${requestId}` : ''}）`);
    }
    const payload = await response.json() as ChatCompletionResponse;
    const content = responseText(payload.choices?.[0]?.message?.content);
    if (!content) throw new Error('百炼 Listing 生成内容为空');
    return {
      output: parseListingGenerationOutput(content, context),
      model: payload.model || model,
      usage: normalizeUsage(payload.usage),
      requestId: payload.id || response.headers.get('x-request-id'),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('百炼 Listing 生成超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export interface VisionImageInput {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  productName: string;
}

export interface BailianVisionResponse {
  output: VisionAnalysisOutput;
  model: string;
  usage: Record<string, number> | null;
  requestId: string | null;
}

export async function hashVisionInput(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', source);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function callBailianVisionAnalysis(
  config: BailianConfig,
  input: VisionImageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BailianVisionResponse> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error('百炼 API Key 尚未配置');
  if (!input.contentType.startsWith('image/')) throw new Error('视觉 Agent 只接受图片文件');
  if (input.bytes.length === 0) throw new Error('图片内容为空');
  if (input.bytes.length > MAX_IMAGE_BYTES) throw new Error('图片超过视觉 Agent 的 8 MB 限制');
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = config.model.trim();
  if (!model) throw new Error('BAILIAN_MODEL 尚未配置');
  const dataUrl = `data:${input.contentType};base64,${toBase64(input.bytes)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: buildVisionAnalysisPrompt(input) },
          ],
        }],
        response_format: { type: 'json_object' },
        enable_thinking: false,
        temperature: 0.1,
        max_completion_tokens: 4_096,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
      throw new Error(`百炼调用失败（HTTP ${response.status}${requestId ? `，Request ID ${requestId}` : ''}）`);
    }
    const payload = await response.json() as ChatCompletionResponse;
    const content = responseText(payload.choices?.[0]?.message?.content);
    if (!content) throw new Error('百炼返回内容为空');
    return {
      output: parseVisionAnalysisOutput(content),
      model: payload.model || model,
      usage: normalizeUsage(payload.usage),
      requestId: payload.id || response.headers.get('x-request-id'),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('百炼调用超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
