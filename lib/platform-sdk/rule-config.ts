import type { AdapterFieldRule, PlatformRuleConfig } from './types';

const PATH_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/i;
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafePath(path: string, label: string): void {
  if (!PATH_PATTERN.test(path) || path.split('.').some((segment) => UNSAFE_SEGMENTS.has(segment))) {
    throw new Error(`${label} 路径无效：${path}`);
  }
}

function validateFieldRule(field: AdapterFieldRule): void {
  assertSafePath(field.sourceFact, 'sourceFact');
  assertSafePath(field.targetPath, 'targetPath');
  if (!field.label.trim()) throw new Error(`规则 ${field.targetPath} 缺少 label`);

  for (const transform of field.transforms ?? []) {
    if (transform.type === 'join' && !transform.separator) {
      throw new Error(`规则 ${field.targetPath} 的 join 需要 separator`);
    }
  }
  for (const validation of field.validations ?? []) {
    if ((validation.type === 'minLength' || validation.type === 'maxLength')
      && (!Number.isInteger(validation.value) || validation.value < 1)) {
      throw new Error(`规则 ${field.targetPath} 的长度限制必须为正整数`);
    }
  }
}

export function definePlatformRules(config: PlatformRuleConfig): PlatformRuleConfig {
  if (config.schemaVersion !== '1.0') throw new Error(`不支持的规则 Schema：${config.schemaVersion}`);
  if (!config.id.trim() || !config.version.trim() || !config.title.trim()) {
    throw new Error('规则配置必须包含 id、version 和 title');
  }
  if (config.fields.length === 0) throw new Error('规则配置至少需要一个字段映射');

  const targets = new Set<string>();
  for (const field of config.fields) {
    validateFieldRule(field);
    if (targets.has(field.targetPath)) throw new Error(`目标字段重复：${field.targetPath}`);
    targets.add(field.targetPath);
  }
  return Object.freeze({ ...config, fields: Object.freeze([...config.fields]) });
}

export const coreProductRules = definePlatformRules({
  schemaVersion: '1.0',
  id: 'core-product',
  version: '1.0.0',
  title: '通用商品草稿规则',
  fields: [
    {
      sourceFact: 'product.name',
      targetPath: 'product.title',
      label: '商品标题',
      transforms: [{ type: 'trim' }],
      validations: [{ type: 'required' }, { type: 'maxLength', value: 200 }],
    },
    {
      sourceFact: 'product.brand',
      targetPath: 'product.brand',
      label: '品牌',
      transforms: [{ type: 'trim' }],
      validations: [{ type: 'required' }, { type: 'maxLength', value: 120 }],
    },
    {
      sourceFact: 'product.category_hint',
      targetPath: 'product.categoryHint',
      label: '候选类目',
      transforms: [{ type: 'trim' }],
      validations: [{ type: 'required' }, { type: 'maxLength', value: 160 }],
    },
    {
      sourceFact: 'product.description',
      targetPath: 'product.description',
      label: '商品描述',
      transforms: [{ type: 'trim' }],
      validations: [{ type: 'maxLength', value: 5000 }],
    },
    {
      sourceFact: 'product.model',
      targetPath: 'product.model',
      label: '型号',
      transforms: [{ type: 'trim' }],
      validations: [{ type: 'maxLength', value: 120 }],
    },
    {
      sourceFact: 'product.material',
      targetPath: 'attributes.material',
      label: '材质',
      transforms: [{ type: 'stringify' }],
    },
    {
      sourceFact: 'product.color',
      targetPath: 'attributes.color',
      label: '颜色',
      transforms: [{ type: 'stringify' }],
    },
    {
      sourceFact: 'package.contents',
      targetPath: 'package.contents',
      label: '包装清单',
      transforms: [{ type: 'join', separator: '；' }],
    },
  ],
});
