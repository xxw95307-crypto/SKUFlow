import type { BailianConfig } from '../config/bailian.ts';
import { isChineseVideoPrompt } from '../domain/video-prompt.ts';

export async function translateVideoPromptToChinese(
  config: BailianConfig,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (isChineseVideoPrompt(prompt)) return prompt;
  if (!config.apiKey || !config.baseUrl || !config.model) throw new Error('视频提示词翻译模型未配置');
  const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model: config.model,
      enable_thinking: false,
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_completion_tokens: 1600,
      messages: [
        { role: 'system', content: '将商品视频生成提示词准确改写为简体中文。只翻译语言，完整保留时长、镜头时间顺序、动作、场景、光线、商品特征和限制；不得新增、删除或推断商品事实。只返回 JSON：{"prompt":"简体中文视频提示词"}。' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!response.ok) throw new Error(`视频提示词翻译失败（HTTP ${response.status}）`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
  const content = payload.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : content ?? '';
  let translated: unknown;
  try { translated = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
  catch { throw new Error('视频提示词翻译结果无效'); }
  const value = (translated as { prompt?: unknown } | null)?.prompt;
  if (typeof value !== 'string' || !isChineseVideoPrompt(value) || value.length > 4000) throw new Error('视频提示词未能转换为中文，请重试');
  return value.trim();
}
