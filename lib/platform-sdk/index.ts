import { coreProductAdapter } from './adapters/core-product-adapter.ts';
import { PlatformAdapterRegistry } from './adapter-registry.ts';

export const platformAdapterRegistry = new PlatformAdapterRegistry()
  .register(coreProductAdapter);

export { PlatformAdapterRegistry } from './adapter-registry.ts';
export { compileWithRules } from './compiler.ts';
export { coreProductRules, definePlatformRules } from './rule-config.ts';
export type {
  AdapterCompileResult,
  AdapterFieldRule,
  AdapterTransform,
  AdapterValidation,
  PlatformAdapter,
  PlatformAdapterContext,
  PlatformAdapterDescriptor,
  PlatformRuleConfig,
} from './types';
