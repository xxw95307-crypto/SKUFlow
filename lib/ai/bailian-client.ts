import { buildFactExtractionMessages, parseFactExtractionOutput, type ExtractionContext } from '../agents/fact-extraction.ts';
import type { BailianConfig } from '../config/bailian.ts';
import type { FactExtractionOutput } from '../domain/fact-extraction';

export interface BailianFactExtractionResponse {
  output: FactExtractionOutput;
  model: string;
  usage: Record<string, number> | null;
  requestId: string | null;
}

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
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
    const content = payload.choices?.[0]?.message?.content;
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
