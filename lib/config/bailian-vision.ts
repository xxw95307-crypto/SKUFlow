export interface BailianVisionEnvironment {
  BAILIAN_API_KEY?: string;
  BAILIAN_VISION_API_KEY?: string;
  BAILIAN_VISION_BASE_URL?: string;
  BAILIAN_VISION_MODEL?: string;
}

export interface BailianVisionConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function loadBailianVisionConfig(environment: BailianVisionEnvironment): BailianVisionConfig {
  return {
    apiKey: environment.BAILIAN_VISION_API_KEY?.trim() || environment.BAILIAN_API_KEY?.trim() || '',
    baseUrl: environment.BAILIAN_VISION_BASE_URL?.trim() ?? '',
    model: environment.BAILIAN_VISION_MODEL?.trim() ?? '',
  };
}

export function missingBailianVisionConfig(config: BailianVisionConfig): string[] {
  return [
    ['BAILIAN_VISION_API_KEY 或 BAILIAN_API_KEY', config.apiKey],
    ['BAILIAN_VISION_BASE_URL', config.baseUrl],
    ['BAILIAN_VISION_MODEL', config.model],
  ].filter((entry) => !entry[1]).map((entry) => entry[0]);
}
