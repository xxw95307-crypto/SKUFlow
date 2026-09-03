import { platformRegistry } from '../../platforms/registry.ts';
import { compileWithRules } from '../compiler.ts';
import { coreProductRules } from '../rule-config.ts';
import type { PlatformAdapter } from '../types';

export const coreProductAdapter: PlatformAdapter = {
  id: 'core-product-adapter',
  name: 'Core Product Adapter',
  version: '1.0.0',
  priority: 0,
  kind: 'fallback',
  supports: platformRegistry.map((platform) => platform.id),
  rules: coreProductRules,
  compile(context) {
    return compileWithRules(context, coreProductRules);
  },
};
