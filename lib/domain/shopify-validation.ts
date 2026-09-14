export interface ShopifyVariantRow { options: string; sku: string; price: string | number; quantity?: string | number; barcode?: string; weight?: string | number }
export const present = (v: unknown) => v !== undefined && v !== null && v !== '';
// Ignore only wholly empty accidental rows. Partial rows must still be validated.
export function normalizeSaleVariants(value: unknown): ShopifyVariantRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(row => !row || typeof row !== 'object' || Object.values(row).some(v => v != null && (typeof v !== 'string' || v.trim() !== '')));
}
export function validateShopifyFields(f: Record<string, any>): string[] {
  f = {...f, variants: normalizeSaleVariants(f.variants)};
  const errors: string[] = [];
  if (!f.title?.trim()) errors.push('请填写商品标题');
  for (const key of ['taxable','requires_shipping','inventory_tracked']) if (typeof f[key] !== 'boolean') errors.push(`请确认${({taxable:'是否收税',requires_shipping:'是否需要运输',inventory_tracked:'是否跟踪库存'} as any)[key]}`);
  const rows = Array.isArray(f.variants) && f.variants.length ? f.variants : [{sku:f.variant_sku,price:f.variant_price,quantity:f.inventory_quantity,weight:f.shipping_weight}];
  const seen = new Set<string>();
  for (const [i,row] of rows.entries()) {
    if (!row || typeof row !== 'object') { errors.push('规格数据格式无效');continue; }
    if (typeof row.sku !== 'string' || !row.sku.trim()) errors.push(`第 ${i+1} 个规格缺少 SKU`);
    if (!present(row.price) || !Number.isFinite(Number(row.price)) || Number(row.price)<0) errors.push(`第 ${i+1} 个规格缺少有效售价`);
    for (const key of ['quantity','weight']) if (present(row[key]) && (!Number.isFinite(Number(row[key])) || Number(row[key])<0 || (key==='quantity' && !Number.isInteger(Number(row[key]))))) errors.push(`第 ${i+1} 个规格的${key==='quantity'?'库存':'重量'}无效`);
    if (f.requires_shipping && !present(row.weight ?? f.shipping_weight)) errors.push(`第 ${i+1} 个规格需要运输重量`);
    if (f.inventory_tracked && !present(row.quantity)) errors.push(`第 ${i+1} 个规格需要库存数量`);
    if (present(row.quantity) && (!f.inventory_tracked || !f.inventory_location)) errors.push('填写库存数量时必须开启跟踪并选择库存地点');
    let signature = 'default';try { if(row.options) signature=Object.entries(parseOptions(row.options)).sort().map(p=>p.join('=')).join(';'); } catch(e) { errors.push((e as Error).message); } if (seen.has(signature)) errors.push('规格组合不能重复'); seen.add(signature);
  }
  if (f.variants?.length) {
    try { const parsed = f.variants.map((r: ShopifyVariantRow)=>parseOptions(r.options)); const names = Object.keys(parsed[0]).sort().join(); if(parsed.some((r: Record<string,string>)=>Object.keys(r).sort().join()!==names)) errors.push('每个变体必须使用相同的规格名称'); } catch(e) { errors.push((e as Error).message); }
  }
  if(f.country_of_origin && !/^[A-Z]{2}$/.test(f.country_of_origin)) errors.push('原产国请使用两位大写国家代码，如 CN');
  if(f.hs_code && !/^\d{6,10}$/.test(f.hs_code)) errors.push('HS 编码必须为 6–10 位数字');
  if(rows.length>100) errors.push('当前一次最多发布 100 个变体');
  return [...new Set(errors)];
}
export function parseOptions(text: string): Record<string,string> {
  const pairs = String(text||'').split(/[;；]/).map(p=>p.trim()).filter(Boolean).map(p=>p.split(/[=＝]/).map(v=>v.trim()));
  if(!pairs.length || pairs.length>3 || pairs.some(p=>p.length!==2 || !p[0] || !p[1]) || new Set(pairs.map(p=>p[0])).size!==pairs.length) throw new Error('规格请填写如“颜色=红色；尺码=M”，最多三个规格名称');
  return Object.fromEntries(pairs);
}
