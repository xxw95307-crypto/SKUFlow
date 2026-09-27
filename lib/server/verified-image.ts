import type { AssetGenerationSpec } from '../agents/asset-generation.ts';
import { callBailianImageGeneration, checkGeneratedImageAgainstIntent, reviseBailianImagePrompt } from '../ai/bailian-client.ts';

type GenerateImage = typeof callBailianImageGeneration;
type ReviewImage = typeof checkGeneratedImageAgainstIntent;
type RevisePrompt = typeof reviseBailianImagePrompt;

export async function generateVerifiedImage(
  imageConfig: Parameters<GenerateImage>[0],
  reviewConfig: Parameters<ReviewImage>[0],
  source: { bytes: Uint8Array; contentType: string },
  spec: AssetGenerationSpec,
  prompt: string,
  userGuidance: string | null,
  reference: { bytes: Uint8Array; contentType: string },
  otherRoles: string[],
  dependencies: { generate: GenerateImage; review: ReviewImage; revise?: RevisePrompt } = { generate: callBailianImageGeneration, review: checkGeneratedImageAgainstIntent, revise: reviseBailianImagePrompt },
) {
  let currentPrompt = prompt;
  let currentNegativePrompt = spec.negativePrompt ?? '';
  let feedback = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generated = await dependencies.generate(imageConfig, {
      ...source,
      prompt: currentPrompt,
      size: spec.size,
      negativePrompt: currentNegativePrompt,
    });
    let check: Awaited<ReturnType<ReviewImage>>;
    try {
      check = await dependencies.review(reviewConfig, {
        bytes: generated.bytes, contentType: generated.contentType, acceptance: spec.acceptance, instruction: spec.instruction,
        userGuidance, reference, imageRole: `${spec.kind}｜${spec.title}｜${spec.note}`, otherRoles,
      });
    } catch {
      throw new Error('图片自动验收暂不可用，本轮图片未交付；已有图片保持不变');
    }
    if (check.matches) return { generated, reviewWarning: null };
    feedback = check.reason || '画面没有满足本张图片的验收标准';
    if (attempt < 2 && dependencies.revise) {
      try {
        const revised = await dependencies.revise(reviewConfig, {
          userGuidance, instruction: spec.instruction, acceptance: spec.acceptance,
          previousPrompt: currentPrompt, negativePrompt: currentNegativePrompt, failure: feedback,
        });
        currentPrompt = `${revised.prompt}\n\n商品身份与本张验收标准必须保持：${spec.acceptance}`;
        currentNegativePrompt = [spec.negativePrompt, revised.negativePrompt].filter(Boolean).join('、');
        continue;
      } catch { /* Retry with the reviewer feedback when prompt revision is unavailable. */ }
    }
    currentPrompt = `${prompt}\n\n上一版未通过画面验收：${feedback}。必须更换画面方案，并满足：${spec.acceptance}`;
  }
  throw new Error(`这次没有生成符合要求的“${spec.title}”，已有图片保持不变。可调整要求或换一张更清晰的商品原图后重试`);
}
