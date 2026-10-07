import assert from 'node:assert/strict';
import test from 'node:test';
import { isChineseVideoPrompt } from '../lib/domain/video-prompt.ts';
import { translateVideoPromptToChinese } from '../lib/ai/video-prompt-language.ts';

const config = { apiKey: 'test-key', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max' };

test('English AI video drafts are translated before review while Chinese drafts are kept', async () => {
  const english = 'The camera slowly moves toward the beige cardigan and green bow, then shows its front buttons.';
  const chinese = '镜头缓慢靠近米色针织开衫和绿色蝴蝶结，再展示前襟的纽扣细节。';
  assert.equal(isChineseVideoPrompt(english), false);
  assert.equal(isChineseVideoPrompt(chinese), true);
  let calls = 0;
  const fetchMock = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    assert.equal(request.messages[1].content, english);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ prompt: chinese }) } }] });
  }) as typeof fetch;
  assert.equal(await translateVideoPromptToChinese(config, english, fetchMock), chinese);
  assert.equal(await translateVideoPromptToChinese(config, chinese, fetchMock), chinese);
  assert.equal(calls, 1);
});

test('translation rejects another English response', async () => {
  await assert.rejects(
    translateVideoPromptToChinese(config, 'Slowly pan over the product, then show the front buttons.',
      (async () => Response.json({ choices: [{ message: { content: '{"prompt":"The camera pans over the product."}' } }] })) as typeof fetch),
    /未能转换为中文/,
  );
});
