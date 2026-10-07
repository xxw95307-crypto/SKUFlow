import { buildFactExtractionMessages, parseFactExtractionOutput, type ExtractionContext } from '../agents/fact-extraction.ts';
import { buildVisionAnalysisPrompt, parseVisionAnalysisOutput } from '../agents/vision-analysis.ts';
import { buildListingGenerationMessages, parseListingGenerationOutput, type ListingGenerationContext } from '../agents/listing-generation.ts';
import { buildListingLocalizationMessages, ListingLocalizationLengthError, parseListingLocalizationOutput, type ListingLocalizationContext } from '../agents/listing-localization.ts';
import { buildAssetPlanningMessages, parseAssetPlan, parseVisualToolDecision, type AssetGenerationSpec, type AssetPlanningContext, type VisualToolDecision } from '../agents/asset-generation.ts';
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
  input: { bytes: Uint8Array; contentType: string; prompt: string; size: string; negativePrompt?: string },
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
          prompt_extend: false,
          watermark: false,
          negative_prompt: ['改变商品本体、错误文字、错误商标、额外商品、低清晰度、畸变、比例错误、虚假配件', input.negativePrompt?.trim()].filter(Boolean).join('、'),
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
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = buildListingLocalizationMessages(context);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
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
      try {
        return {
          fields: parseListingLocalizationOutput(content, context),
          model: payload.model || model,
          usage: normalizeUsage(payload.usage),
          requestId: payload.id || response.headers.get('x-request-id'),
        };
      } catch (error) {
        if (!(error instanceof ListingLocalizationLengthError) || attempt > 0) throw error;
        messages.push(
          { role: 'assistant', content },
          { role: 'user', content: `上次译文的 ${error.fieldKey}（${error.fieldLabel}）有 ${error.actualLength} 个字符，超过 ${error.maxLength} 字符上限。请保留原意与所有已确认的商品事实，尽量把这个字段精简到 ${Math.max(1, Math.floor(error.maxLength * 0.8))} 个字符以内，绝对不能超过 ${error.maxLength} 个字符（包含空格和标点）；其他字段、数组条目数和 JSON 结构保持不变。重新输出完整 JSON。` },
        );
      }
    }
    throw new Error('Listing 本地化未能通过长度校验');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('百炼 Listing 本地化超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callBailianVisualIntent(
  config: BailianConfig,
  input: { request: string; existingAssets: readonly { kind: string; title: string; note: string }[] },
  fetchImpl: typeof fetch = fetch,
): Promise<VisualToolDecision> {
  const apiKey = config.apiKey.trim();
  const model = config.model.trim();
  if (!apiKey || !model) throw new Error('百炼图片需求分析配置不完整');
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [{
    role: 'system',
    content: `你是商品图片需求分析 Agent。只分析商家本轮原话，不生成图片。返回 JSON：{"scope":"FULL_SET 或 SELECTED","count":数字或null,"style":字符串或null,"targetIndices":数组}。
FULL_SET 表示首次生成、重新生成整组、改变图片总数，或列出要生成的几种新图片；targetIndices 必须为空。SELECTED 只用于商家明确指向当前已有的一张或数张图片进行修改；targetIndices 填当前图片从 1 开始的序号，count 必须为 null。“一张海报、一张模特图”是在列出新图类型，不是在指已有图片序号。“生成一张海报图就可以了”也是新的一张图，选择 FULL_SET、count=1；只有“把第一张改成海报”才选择 SELECTED。不要把前一轮偏好当成本轮要求。若没有现有图片，只能 FULL_SET。若本轮原话只要求重新生成图片且没有指向已有图片，选择 FULL_SET。count 只有商家明确指定总数时才填写，范围 1–6；style 仅填商家提出的风格或视觉要求。必须明确填写 scope。`,
  }, { role: 'user', content: JSON.stringify(input) }];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, enable_thinking: false, temperature: 0.1, max_completion_tokens: 300, stream: false }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`百炼图片需求分析失败（HTTP ${response.status}）`);
    const payload = await response.json() as ChatCompletionResponse;
    const content = responseText(payload.choices?.[0]?.message?.content);
    try {
      const decision = parseVisualToolDecision(content, input.existingAssets.length);
      if (!input.existingAssets.length && decision.scope !== 'FULL_SET') throw new Error('当前没有可修改的已有图片');
      return decision;
    } catch (error) {
      if (attempt === 1) throw new Error('暂时无法确定要生成整组图片还是修改指定图片，请说明图片范围后重试');
      messages.push({ role: 'user', content: `上一版图片范围判断无效：${error instanceof Error ? error.message : '格式错误'}。请重新分析本轮原话，必须输出完整 JSON；整组重新生成应选择 FULL_SET。` });
    }
  }
  throw new Error('图片需求分析未完成');
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
        const assets = parseAssetPlan(content, context.requestedCount, context.targetIndices);
        if (context.userGuidance?.trim()) {
          const review = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model, messages: [
              { role: 'system', content: '你是独立的商品图片需求核对员。商家本轮原话是唯一的创作要求，旧图仅供定位，不可把旧图或以前的偏好当成本轮限制。先把原话拆成每张独立目标，再核对计划的每一张是否有相应且不同的画面任务及可检验的验收标准。只有标题写“海报”而 instruction 只是普通人物场景照，不算完成海报；不同目标不能都规划成同一类场景图。逐项核对数量、人物、风格、排除项、参考图来源和局部修改范围。商家明确要求某图不得出现的元素，必须同时写入该图的 instruction、acceptance 和 negativePrompt；缺失任一项必须拒绝。旧图含有待去除的元素或需要彻底改变画面形式时，sourceMode 必须是 ORIGINAL。计划把商家明确要求出现的元素写成禁止出现、或凭空添加排除项时必须拒绝。只返回 JSON：{"satisfies":true或false,"reason":"具体遗漏或冲突"}。' },
              { role: 'user', content: JSON.stringify({ request: context.userGuidance, requestedCount: context.requestedCount, targetIndices: context.targetIndices, existingAssets: context.existingAssets, plan: assets }) },
            ], response_format: { type: 'json_object' }, enable_thinking: false, temperature: 0.1, max_completion_tokens: 300, stream: false }),
            signal: controller.signal,
          });
          if (!review.ok) throw new Error(`图片方案核对失败（HTTP ${review.status}）`);
          const reviewPayload = await review.json() as ChatCompletionResponse;
          let judgment: { satisfies?: unknown; reason?: unknown };
          try { judgment = JSON.parse(responseText(reviewPayload.choices?.[0]?.message?.content)) as typeof judgment; }
          catch { throw new Error('图片方案核对结果无法解析'); }
          if (judgment.satisfies !== true) throw new Error(`方案未覆盖商家要求：${typeof judgment.reason === 'string' ? judgment.reason.slice(0, 180) : '请按本轮要求重新规划'}`);
        }
        return {
          assets,
          model: payload.model || model,
          usage: normalizeUsage(payload.usage),
          requestId: payload.id || response.headers.get('x-request-id'),
        };
      } catch (error) {
        if (attempt === 1) throw error;
        messages.push({ role: 'user', content: `上一版方案未通过商家要求校验：${error instanceof Error ? error.message : '方案不符'}。请重新理解商家自然语言要求，并输出符合要求的完整 JSON。不要自行添加商家没有要求的图片类型。` });
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

export async function checkGeneratedImageAgainstIntent(
  config: BailianConfig,
  input: { bytes: Uint8Array; contentType: string; acceptance: string; instruction: string; userGuidance?: string | null; imageRole?: string; otherRoles?: string[]; reference?: { bytes: Uint8Array; contentType: string } },
  fetchImpl: typeof fetch = fetch,
): Promise<{ matches: boolean; reason: string }> {
  if (!input.contentType.startsWith('image/') || !input.bytes.length || input.bytes.length > MAX_IMAGE_BYTES) throw new Error('待核对图片无效或超过 8 MB');
  const reference = input.reference && input.reference.contentType.startsWith('image/') && input.reference.bytes.length > 0 && input.reference.bytes.length <= MAX_IMAGE_BYTES ? input.reference : null;
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey.trim()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model.trim(),
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${input.contentType};base64,${toBase64(input.bytes)}` } },
        ...(reference ? [{ type: 'image_url', image_url: { url: `data:${reference.contentType};base64,${toBase64(reference.bytes)}` } }] : []),
        { type: 'text', text: `你是独立的成图核对员。第一张图是生成结果，${reference ? '第二张是原始商品参考图。' : ''}商家整组原话仅用于理解分工：${input.userGuidance?.trim() || '未补充'}。你只核对当前这一张的任务：${input.imageRole || '以本张策划为准'}；同组其他图片的任务：${input.otherRoles?.join('；') || '无'}，不得拿其他图片的要求为本张判通过。本张策划验收标准：${input.acceptance}。本张创作指令：${input.instruction}。先检查画面形式是否一眼可辨为本张目标，再检查元素、商品身份与真实标识。海报等设计图需有设计构图和视觉层次，不能把普通模特场景照片当成海报；是否包含人物以本张要求为准。若策划标准与商家原话冲突，按本张在原话中的目标判断。参考图文字或刺绣辨认不清时不要猜测。只返回 JSON：{"matches":true或false,"reason":"简短中文理由"}。` },
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

export async function reviseBailianImagePrompt(
  config: BailianConfig,
  input: { userGuidance: string | null; instruction: string; acceptance: string; previousPrompt: string; negativePrompt?: string; failure: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ prompt: string; negativePrompt: string }> {
  const response = await fetchImpl(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey.trim()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model.trim(),
      messages: [
        { role: 'system', content: '你是商品视觉生成修正 Agent。上一张成图没有通过验收。请把反馈转成新的、具体可执行的画面方案，而不是重复原提示词或简单追加“不要出现”。商家本轮要求与单张验收标准优先；只改变构图、主体呈现和场景策略，保留真实商品身份。不得从旧图或历史偏好添加本轮未要求的禁令。仅返回 JSON：{"prompt":"完整中文生成指令","negativePrompt":"本张图必须排除的画面元素，没有则为空字符串"}。' },
        { role: 'user', content: JSON.stringify(input) },
      ],
      response_format: { type: 'json_object' }, enable_thinking: false, temperature: 0.3, max_completion_tokens: 1300, stream: false,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`图片方案修正失败（HTTP ${response.status}）`);
  const payload = await response.json() as ChatCompletionResponse;
  let revised: { prompt?: unknown; negativePrompt?: unknown };
  try { revised = JSON.parse(responseText(payload.choices?.[0]?.message?.content)) as typeof revised; }
  catch { throw new Error('图片方案修正结果无法解析'); }
  if (typeof revised.prompt !== 'string' || revised.prompt.trim().length < 30 || revised.prompt.length > 4000 || typeof revised.negativePrompt !== 'string') {
    throw new Error('图片方案修正内容不完整');
  }
  return { prompt: revised.prompt.trim(), negativePrompt: revised.negativePrompt.trim().slice(0, 300) };
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
