export interface BailianEnvironment {
  BAILIAN_API_KEY?: string;
  BAILIAN_BASE_URL?: string;
  BAILIAN_MODEL?: string;
  BAILIAN_IMAGE_MODEL?: string;
}

export interface BailianImageConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
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

export function loadBailianImageConfig(environment: BailianEnvironment): BailianImageConfig {
  return {
    apiKey: environment.BAILIAN_API_KEY?.trim() ?? '',
    baseUrl: environment.BAILIAN_BASE_URL?.trim() ?? '',
    model: environment.BAILIAN_IMAGE_MODEL?.trim() ?? '',
  };
}

export function missingBailianImageConfig(config: BailianImageConfig): string[] {
  return [
    ['BAILIAN_API_KEY', config.apiKey],
    ['BAILIAN_BASE_URL', config.baseUrl],
    ['BAILIAN_IMAGE_MODEL', config.model],
  ].filter((entry) => !entry[1]).map((entry) => entry[0]);
}
