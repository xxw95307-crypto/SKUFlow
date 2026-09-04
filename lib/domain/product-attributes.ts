export interface ProductAttributeDefinition {
  key: string;
  label: string;
}

export const PRODUCT_ATTRIBUTE_DEFINITIONS: readonly ProductAttributeDefinition[] = [
  { key: 'product.name', label: '商品名称' },
  { key: 'product.brand', label: '品牌' },
  { key: 'product.model', label: '型号' },
  { key: 'product.category_hint', label: '候选类目' },
  { key: 'product.description', label: '商品描述' },
  { key: 'product.material', label: '主要材质' },
  { key: 'product.color', label: '颜色' },
  { key: 'product.capacity', label: '容量' },
  { key: 'product.power', label: '额定功率' },
  { key: 'product.voltage', label: '额定电压' },
  { key: 'product.weight.net', label: '商品净重' },
  { key: 'product.dimensions', label: '商品尺寸' },
  { key: 'battery.capacity', label: '电池容量' },
  { key: 'battery.energy', label: '电池能量' },
  { key: 'package.contents', label: '包装清单' },
  { key: 'compliance.certifications', label: '认证信息' },
  { key: 'product.blade_count', label: '刀片数量' },
  { key: 'product.blade_material', label: '刀片材质' },
  { key: 'product.speed_levels', label: '档位数量' },
] as const;

const aliases: Readonly<Record<string, string>> = {
  'blade_count': 'product.blade_count',
  'blade.count': 'product.blade_count',
  'blades.count': 'product.blade_count',
  'product.blades': 'product.blade_count',
  'product.blades.count': 'product.blade_count',
  'blade_material': 'product.blade_material',
  'blade.material': 'product.blade_material',
  'product.blades.material': 'product.blade_material',
  'speed_levels': 'product.speed_levels',
  'product.speed.levels': 'product.speed_levels',
  'product.net_weight': 'product.weight.net',
  'product.weight_net': 'product.weight.net',
  'battery_capacity': 'battery.capacity',
  'battery_energy': 'battery.energy',
};

export function normalizeProductAttributeKey(value: string): string {
  const key = value.trim().toLowerCase();
  return aliases[key] ?? key;
}

export function productAttributeLabel(key: string, fallback: string): string {
  return PRODUCT_ATTRIBUTE_DEFINITIONS.find((definition) => definition.key === key)?.label ?? fallback;
}

const unstableAttributePrefixes = [
  'commerce.',
  'listing.price',
  'price.',
  'product.price',
  'promotion.',
  'sales.',
  'store.',
  'ui.',
];

export function isStableProductAttributeKey(key: string): boolean {
  return !unstableAttributePrefixes.some((prefix) => key === prefix.replace(/\.$/, '') || key.startsWith(prefix));
}
