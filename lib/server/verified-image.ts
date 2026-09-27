import type { AssetGenerationSpec } from '../agents/asset-generation.ts';
import { callBailianImageGeneration, checkGeneratedImageAgainstIntent } from '../ai/bailian-client.ts';

type GenerateImage = typeof callBailianImageGeneration;
type ReviewImage = typeof checkGeneratedImageAgainstIntent;

export async function generateVerifiedImage(
  imageConfig: Parameters<GenerateImage>[0],
  reviewConfig: Parameters<ReviewImage>[0],
  source: { bytes: Uint8Array; contentType: string },
  spec: AssetGenerationSpec,
  prompt: string,
  userGuidance: string | null,
  reference: { bytes: Uint8Array; contentType: string },
  otherRoles: string[],
  dependencies: { generate: GenerateImage; review: ReviewImage } = { generate: callBailianImageGeneration, review: checkGeneratedImageAgainstIntent },
) {
  let feedback = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generated = await dependencies.generate(imageConfig, {
      ...source,
      prompt: feedback ? `${prompt}\n\n上一版未通过画面验收：${feedback}。这次必须改变画面方案，明确避开上述错误，并严格满足：${spec.acceptance}` : prompt,
      size: spec.size,
      negativePrompt: spec.negativePrompt,
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
  }
  throw new Error(`“${spec.title}”连续三次未通过画面验收：${feedback}。本轮未保存不符合要求的图片，已有图片保持不变`);
}
