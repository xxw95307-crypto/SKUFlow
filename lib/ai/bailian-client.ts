import { buildFactExtractionMessages, parseFactExtractionOutput, type ExtractionContext } from '../agents/fact-extraction.ts';
import { buildVisionAnalysisPrompt, parseVisionAnalysisOutput } from '../agents/vision-analysis.ts';
import { buildListingGenerationMessages, parseListingGenerationOutput, type ListingGenerationContext } from '../agents/listing-generation.ts';
import { buildListingLocalizationMessages, parseListingLocalizationOutput, type ListingLocalizationContext } from '../agents/listing-localization.ts';
import { buildAssetPlanningMessages, parseAssetPlan, type AssetGenerationSpec, type AssetPlanningContext } from '../agents/asset-generation.ts';
import type { BailianConfig, BailianImageConfig } from '../config/bailian.ts';
import type { FactExtractionOutput } from '../domain/fact-extraction';
import type { VisionAnalysisOutput } from '../domain/vision-analysis';
import type { ListingGenerationOutput } from '../domain/listing';
import {
  isAgentToolName,
  type AgentModelMessage,
  type AgentOrchestratorResponse,
  type AgentToolCall,
  type AgentToolDefinition,
} from '../domain/agent-orchestrator.ts';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;

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

export interface BailianListingLocalizationResponse {
  fields: Record<string, unknown>;
  model: string;
  usage: Record<string, number> | null;
  requestId: string | null;
}

export interface BailianAssetPlanningResponse {
  assets: AssetGenerationSpec[];
  model: string;
  usage: Record<string, number> | null;
  requestId: string | null;
}

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: {
    content?: string | Array<{ text?: string }> | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  } }>;
  usage?: Record<string, unknown>;
}

interface ImageGenerationResponse {
  request_id?: string;
  code?: string;
  message?: string;
  output?: {
    choices?: Array<{ message?: { content?: Array<{ image?: string }> } }>;
  };
  usage?: { image_count?: number; width?: number; height?: number };
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

function imageGenerationEndpoint(value: string): string {
  const compatibleBase = normalizeBaseUrl(value);
  const parsed = new URL(compatibleBase);
  return `${parsed.origin}/api/v1/services/aigc/multimodal-generation/generation`;
}

function normalizeUsage(value: Record<string, unknown> | undefined): Record<string, number> | null {
  if (!value) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function responseText(content: string | Array<{ text?: string }> | null | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => item.text ?? '').join('');
  return '';
}

function toBailianMessages(messages: AgentModelMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls } : {}),
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      };
    }
    return message;
  });
}

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bailianHttpError(response: Response, requestId: string | null, baseUrl: string, apiKey: string): Promise<Error> {
  let code = '';
  let detail = '';
  try {
    const body = await response.json() as Record<string, unknown>;
    const nested = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : body;
    code = typeof nested.code === 'string' ? nested.code : typeof nested.type === 'string' ? nested.type : '';
    detail = typeof nested.message === 'string' ? nested.message : '';
  } catch { /* Some upstream failures have no JSON body. */ }
  const safeCode = /^[\w.-]{1,80}$/.test(code) ? code : '';
  const safeDetail = detail.replace(/sk-[\w.-]{8,}/g, '[已隐藏的 API Key]').slice(0, 240);
  const reason = [safeCode, safeDetail].filter(Boolean).join('：');
  const reference = requestId ? `，Request ID ${requestId}` : '';
  const configurationHint = baseUrl.includes('token-plan.') && !apiKey.startsWith('sk-sp-')
    ? '当前配置使用 Token Plan 地址，但 API Key 不是 Token Plan 专属 Key；请分别配置文本模型和视频模型的 Key。'
    : '请核对当前部署的 API Key、Base URL、模型调用权限及套餐/账户状态。';
  const hint = response.status === 403 ? ` ${configurationHint}修复配置后再重试当前步骤。` : '';
  return new Error(`百炼 Agent 编排失败（HTTP ${response.status}${reference}）${reason ? `：${reason}` : ''}${hint}`);
}

export async function callBailianOrchestrator(
  config: BailianConfig,
  input: {
    systemPrompt: string;
    messages: AgentModelMessage[];
    tools: AgentToolDefinition[];
    requireTool: boolean;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<Omit<AgentOrchestratorResponse, 'state'>> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error('百炼 API Key 尚未配置');
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = config.model.trim();
  if (!model) throw new Error('BAILIAN_MODEL 尚未配置');
  const forcedTool = input.requireTool && input.tools.length === 1 ? input.tools[0].function.name : null;
  const requestBody = JSON.stringify({
    model,
    messages: [{ role: 'system', content: input.systemPrompt }, ...toBailianMessages(input.messages)],
    ...(input.tools.length ? {
      tools: input.tools,
      tool_choice: forcedTool
        ? { type: 'function', function: { name: forcedTool } }
        : input.requireTool ? 'required' : 'auto',
      parallel_tool_calls: false,
    } : {}),
    enable_thinking: false,
    temperature: 0.1,
    max_completion_tokens: 1_024,
    stream: false,
  });

  // 429/5xx 指数退避重试：百炼限流（素材生成阶段请求密集）在秒级窗口内即可恢复，
  // 自动重试避免演示流程被中断；Retry-After 优先且封顶 30 秒。
  let lastError: Error = new Error('百炼 Agent 编排失败');
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      });
      if (!response.ok) {
        const requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
        const error = await bailianHttpError(response, requestId, baseUrl, apiKey);
        if (RETRYABLE_HTTP_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
          const retryAfterHeader = Number(response.headers.get('retry-after'));
          const delay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
            ? Math.min(retryAfterHeader * 1_000, 30_000)
            : RETRY_DELAYS_MS[attempt];
          await sleep(delay);
          continue;
        }
        throw error;
      }
      const payload = await response.json() as ChatCompletionResponse;
      const rawMessage = payload.choices?.[0]?.message;
      if (!rawMessage) throw new Error('百炼 Agent 返回内容为空');
      const toolCalls: AgentToolCall[] = (rawMessage.tool_calls ?? []).flatMap((call) => {
        const name = call.function?.name;
        if (!call.id || call.type !== 'function' || !isAgentToolName(name)) return [];
        return [{
          id: call.id,
          type: 'function' as const,
          function: { name, arguments: call.function?.arguments || '{}' },
        }];
      });
      const content = responseText(rawMessage.content).trim() || null;
      if (!content && toolCalls.length === 0) throw new Error('百炼 Agent 未返回回复或工具调用');
      return {
        message: { role: 'assistant', content, toolCalls },
        model: payload.model || model,
        usage: normalizeUsage(payload.usage),
        requestId: payload.id || response.headers.get('x-request-id'),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('百炼 Agent 编排超时');
      lastError = error instanceof Error ? error : new Error('百炼 Agent 编排失败');
      // 非限流类错误（参数、鉴权、内容问题）没有重试价值，直接抛出。
      if (!/HTTP (429|500|502|503|504)/.test(lastError.message)) throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export interface BailianGeneratedImage {
  bytes: Uint8Array;
  contentType: string;
  model: string;
  requestId: string | null;
  width: number | null;
  height: number | null;
}

export async function callBailianImageGeneration(
  config: BailianImageConfig,
  input: { bytes: Uint8Array; contentType: string; prompt: string; size: string },
  fetchImpl: typeof fetch = fetch,
): Promise<BailianGeneratedImage> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error('百炼 API Key 尚未配置');
  if (!input.contentType.startsWith('image/')) throw new Error('素材生成只接受图片作为参考图');
  if (input.bytes.length === 0) throw new Error('参考图片内容为空');
  if (input.bytes.length > MAX_IMAGE_BYTES) throw new Error('参考图片超过 8 MB 限制');
  const model = config.model.trim();
  if (!model) throw new Error('BAILIAN_IMAGE_MODEL 尚未配置');
  const dataUrl = `data:${input.contentType};base64,${toBase64(input.bytes)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const response = await fetchImpl(imageGenerationEndpoint(config.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content: [{ image: dataUrl }, { text: input.prompt }] }] },
        parameters: {
          n: 1,
          size: input.size,
          prompt_extend: true,
          watermark: false,
          negative_prompt: '改变商品本体、错误文字、错误商标、额外商品、低清晰度、畸变、比例错误、虚假配件',
        },
      }),
      signal: controller.signal,
    });
    const payload = await response.json() as ImageGenerationResponse;
    if (!response.ok || payload.code) {
      const requestId = payload.request_id || response.headers.get('x-request-id');
      throw new Error(`百炼素材生成失败（${payload.message || `HTTP ${response.status}`}${requestId ? `，Request ID ${requestId}` : ''}）`);
    }
    const imageUrl = payload.output?.choices?.flatMap((choice) => choice.message?.content ?? []).find((item) => item.image)?.image;
    if (!imageUrl) throw new Error('百炼素材生成未返回图片');
    const parsedImageUrl = new URL(imageUrl);
    if (parsedImageUrl.protocol !== 'https:' || !parsedImageUrl.hostname.endsWith('.aliyuncs.com')) {
      throw new Error('百炼返回了不受信任的图片地址');
    }
    const downloaded = await fetchImpl(imageUrl, { signal: controller.signal });
    if (!downloaded.ok) throw new Error(`生成图片下载失败（HTTP ${downloaded.status}）`);
    const contentLength = Number(downloaded.headers.get('content-length') || 0);
    if (contentLength > MAX_GENERATED_IMAGE_BYTES) throw new Error('生成图片超过 20 MB 限制');
    const bytes = new Uint8Array(await downloaded.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_GENERATED_IMAGE_BYTES) throw new Error('生成图片内容无效');
    return {
      bytes,
      contentType: downloaded.headers.get('content-type')?.split(';')[0] || 'image/png',
      model,
      requestId: payload.request_id || response.headers.get('x-request-id'),
      width: typeof payload.usage?.width === 'number' ? payload.usage.width : null,
      height: typeof payload.usage?.height === 'number' ? payload.usage.height : null,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('百炼素材生成超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

export async function callBailianListingLocalization(
  config: BailianConfig,
  context: ListingLocalizationContext,
  fetchImpl: typeof fetch = fetch,
): Promise<BailianListingLocalizationResponse> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error('百炼 API Key 尚未配置');
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = config.model.trim();
  if (!model) throw new Error('BAILIAN_MODEL 尚未配置');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: buildListingLocalizationMessages(context),
        response_format: { type: 'json_object' },
        enable_thinking: false,
        temperature: 0.15,
        max_completion_tokens: 4_096,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
      throw new Error(`百炼 Listing 本地化失败（HTTP ${response.status}${requestId ? `，Request ID ${requestId}` : ''}）`);
    }
    const payload = await response.json() as ChatCompletionResponse;
    const content = responseText(payload.choices?.[0]?.message?.content);
    if (!content) throw new Error('百炼 Listing 本地化返回内容为空');
    return {
      fields: parseListingLocalizationOutput(content, context),
      model: payload.model || model,
      usage: normalizeUsage(payload.usage),
      requestId: payload.id || response.headers.get('x-request-id'),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('百炼 Listing 本地化超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callBailianAssetPlanning(
  config: BailianConfig,
  context: AssetPlanningContext,
  fetchImpl: typeof fetch = fetch,
): Promise<BailianAssetPlanningResponse> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error('百炼 API Key 尚未配置');
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = config.model.trim();
  if (!model) throw new Error('BAILIAN_MODEL 尚未配置');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = buildAssetPlanningMessages(context);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: 'json_object' },
        enable_thinking: false,
        temperature: 0.35,
        max_completion_tokens: 3_072,
        stream: false,
      }),
      signal: controller.signal,
      });
      if (!response.ok) {
        const requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
        throw new Error(`百炼视觉策划失败（HTTP ${response.status}${requestId ? `，Request ID ${requestId}` : ''}）`);
      }
      const payload = await response.json() as ChatCompletionResponse;
      const content = responseText(payload.choices?.[0]?.message?.content);
      if (!content) throw new Error('百炼视觉策划返回内容为空');
      try {
        return {
          assets: parseAssetPlan(content, context.requestedCount, context.targetIndices, context.requiredKinds),
          model: payload.model || model,
          usage: normalizeUsage(payload.usage),
          requestId: payload.id || response.headers.get('x-request-id'),
        };
      } catch (error) {
        if (attempt === 1) throw error;
        messages.push({ role: 'user', content: `上一版方案未通过商家要求校验：${error instanceof Error ? error.message : '类型或数量不符'}。请重新输出完整 JSON；不得用商品主图替代商家指定的海报图或模特图。` });
      }
    }
    throw new Error('百炼视觉策划未返回符合要求的方案');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('百炼视觉策划超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkGeneratedImageKind(
  config: BailianConfig,
  input: { bytes: Uint8Array; contentType: string; kind: 'MODEL' | 'POSTER' },
  fetchImpl: typeof fetch = fetch,
): Promise<{ matches: boolean; reason: string }> {
  if (!input.contentType.startsWith('image/') || !input.bytes.length || input.bytes.length > MAX_IMAGE_BYTES) throw new Error('待核对图片无效或超过 8 MB');
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const requirement = input.kind === 'MODEL'
    ? '图片里必须有清晰可见的真人模特实际穿着这件商品。单独商品照、平铺图、衣架图均不符合。'
    : '图片必须有明显的商品海报式设计构图或版式层次。普通白底商品照、简单场景照均不符合。';
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey.trim()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model.trim(),
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${input.contentType};base64,${toBase64(input.bytes)}` } },
        { type: 'text', text: `只检查这张生成图片是否符合以下图片类型要求：${requirement}。不要根据标题或生成指令猜测，只看图片。只返回 JSON：{"matches":true或false,"reason":"简短中文理由"}。` },
      ] }],
      response_format: { type: 'json_object' }, enable_thinking: false, temperature: 0.1, max_completion_tokens: 200, stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`生成图片核对失败（HTTP ${response.status}）`);
  const payload = await response.json() as ChatCompletionResponse;
  const content = responseText(payload.choices?.[0]?.message?.content);
  let result: { matches?: unknown; reason?: unknown };
  try { result = JSON.parse(content) as typeof result; } catch { throw new Error('生成图片核对结果无法解析'); }
  if (typeof result.matches !== 'boolean') throw new Error('生成图片核对结果缺少判断');
  return { matches: result.matches, reason: typeof result.reason === 'string' ? result.reason.slice(0, 160) : '' };
}

export interface VisionImageInput {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  productName: string | null;
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
