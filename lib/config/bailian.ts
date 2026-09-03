export interface BailianEnvironment {
  BAILIAN_API_KEY?: string;
  BAILIAN_BASE_URL?: string;
  BAILIAN_MODEL?: string;
}

export interface BailianConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function loadBailianConfig(environment: BailianEnvironment): BailianConfig {
  return {
    apiKey: environment.BAILIAN_API_KEY?.trim() ?? '',
    baseUrl: environment.BAILIAN_BASE_URL?.trim() ?? '',
    model: environment.BAILIAN_MODEL?.trim() ?? '',
  };
}

export function missingBailianConfig(config: BailianConfig): string[] {
  return [
    ['BAILIAN_API_KEY', config.apiKey],
    ['BAILIAN_BASE_URL', config.baseUrl],
    ['BAILIAN_MODEL', config.model],
  ].filter((entry) => !entry[1]).map((entry) => entry[0]);
}
