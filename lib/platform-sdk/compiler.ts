import type { DraftValidationIssue, FactValue, ProductFact } from '../domain/product-passport';
import type {
  AdapterCompileResult,
  AdapterFieldRule,
  AdapterTransform,
  PlatformAdapterContext,
  PlatformRuleConfig,
} from './types';

function isUsableFact(fact: ProductFact | undefined): fact is ProductFact {
  return Boolean(fact && fact.value !== null && fact.status !== 'MISSING' && fact.status !== 'CONFLICT');
}

function transformValue(value: FactValue, transforms: readonly AdapterTransform[]): unknown {
  return transforms.reduce<unknown>((current, transform) => {
    if (transform.type === 'trim') return typeof current === 'string' ? current.trim() : current;
    if (transform.type === 'lowercase') return typeof current === 'string' ? current.toLowerCase() : current;
    if (transform.type === 'uppercase') return typeof current === 'string' ? current.toUpperCase() : current;
    if (transform.type === 'join') return Array.isArray(current) ? current.join(transform.separator) : current;
    if (transform.type === 'stringify') {
      return typeof current === 'string' ? current : JSON.stringify(current);
    }
    return current;
  }, value);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = target;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  });
}

function missingIssue(field: AdapterFieldRule): DraftValidationIssue | null {
  const required = field.validations?.some((validation) => validation.type === 'required');
  return required ? {
    code: 'required_fact_missing',
    path: field.targetPath,
    severity: 'error',
    message: `${field.label}缺少可用事实，需补充或解决冲突。`,
  } : null;
}

function validateValue(field: AdapterFieldRule, value: unknown): DraftValidationIssue[] {
  const issues: DraftValidationIssue[] = [];
  for (const validation of field.validations ?? []) {
    if (validation.type === 'required') {
      if (value === '' || value === null || value === undefined) {
        issues.push({ code: 'required_value_empty', path: field.targetPath, severity: 'error', message: `${field.label}不能为空。` });
      }
      continue;
    }
    const length = typeof value === 'string' || Array.isArray(value) ? value.length : null;
    if (length === null) continue;
    if (validation.type === 'minLength' && length < validation.value) {
      issues.push({ code: 'min_length', path: field.targetPath, severity: 'warning', message: `${field.label}少于 ${validation.value} 个字符。` });
    }
    if (validation.type === 'maxLength' && length > validation.value) {
      issues.push({ code: 'max_length', path: field.targetPath, severity: 'error', message: `${field.label}超过 ${validation.value} 个字符。` });
    }
  }
  return issues;
}

export function compileWithRules(
  context: PlatformAdapterContext,
  rules: PlatformRuleConfig,
): AdapterCompileResult {
  const factByKey = new Map(context.passport.facts.map((fact) => [fact.key, fact]));
  const productData: Record<string, unknown> = {};
  const validationIssues: DraftValidationIssue[] = [];
  let mappedFields = 0;
  let skippedFields = 0;

  for (const field of rules.fields) {
    const fact = factByKey.get(field.sourceFact);
    if (!isUsableFact(fact)) {
      skippedFields += 1;
      const issue = missingIssue(field);
      if (issue) validationIssues.push(issue);
      continue;
    }
    const value = transformValue(fact.value, field.transforms ?? []);
    setPath(productData, field.targetPath, value);
    validationIssues.push(...validateValue(field, value));
    mappedFields += 1;
  }

  return {
    schemaVersion: `${rules.id}@${rules.version}`,
    payload: {
      adapter: { ruleId: rules.id, ruleVersion: rules.version },
      target: {
        platformId: context.platform.id,
        market: context.draft.market,
        locale: context.draft.locale,
      },
      source: {
        passportId: context.passport.id,
        passportVersion: context.passport.version,
      },
      data: productData,
    },
    validationIssues,
    mappedFields,
    skippedFields,
  };
}
