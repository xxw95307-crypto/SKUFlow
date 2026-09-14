'use client';
import { useState } from 'react';
import type { ListingFieldDefinition } from '@/lib/domain/listing';
import type { ShopifyVariantRow } from '@/lib/domain/shopify-validation';
export function ShopifyLookupEditor({field,value,onChange}:{field:ListingFieldDefinition;value:unknown;onChange:(v:unknown)=>void}) {
  const [query,setQuery]=useState('');const [options,setOptions]=useState<Array<{value:string;label:string}>>(field.options ?? []);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const search=async()=>{setBusy(true);setError('');try{const r=await fetch(`/api/integrations/shopify-options?kind=${field.lookup}&q=${encodeURIComponent(query)}`);const d=await r.json() as {options:Array<{value:string;label:string}>;error?:string};if(!r.ok)throw new Error(d.error);setOptions(d.options);if(!d.options.length)setError('未找到匹配项，可换一个关键词（分类支持英文搜索）');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div className="shopify-lookup"><div className="shopify-lookup-search">{field.lookup!=='locations'&&<input aria-label="搜索关键词" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索实际店铺选项"/>}<button type="button" onClick={search} disabled={busy}>{busy?'读取中…':'读取选项'}</button></div><select aria-label={field.label} multiple={field.type==='string_array'} value={field.type==='string_array'?(Array.isArray(value)?value:[]):String(value??'')} onChange={e=>onChange(field.type==='string_array'?Array.from(e.target.selectedOptions).map(o=>o.value):e.target.value)}><option value="">暂不设置</option>{Boolean(value)&&!options.some(o=>o.value===value)&&!Array.isArray(value)&&<option value={String(value)}>{String(value)}</option>}{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>{error&&<p role="alert">{error}</p>}</div>;
}
export function ShopifyVariantsEditor({value,onChange}:{value:unknown;onChange:(v:unknown)=>void}) {
  const rows:ShopifyVariantRow[]=Array.isArray(value)?value:[];
  const update=(i:number,key:string,v:string)=>onChange(rows.map((r,j)=>j===i?{...r,[key]:v}:r));
  return <div className="shopify-variants">
    <p className="shopify-variants-help">仅添加实际销售的规格。误加可直接删除；没有多规格时，使用商品的 SKU 和售价。完全空白的规格不会参与发布。</p>
    {rows.map((row,i)=><section key={i} className="shopify-variant-row" aria-label={`销售规格 ${i+1}`}>
      <div className="shopify-variant-heading"><strong>规格 {i+1}</strong><button className="shopify-variant-delete" type="button" onClick={()=>onChange(rows.filter((_,j)=>j!==i))}>删除规格 {i+1}</button></div>
      <div className="shopify-variant-fields">{([['options','规格（颜色=红色；尺码=M）'],['sku','SKU'],['price','售价（店铺币种）'],['quantity','库存（仅跟踪库存时必填）'],['barcode','条码（可选）'],['weight','重量 kg（仅需要运输时必填）']] as const).map(([key,label])=><label key={key}><span>{label}</span><input aria-label={`规格${i+1} ${label}`} value={row[key]??''} onChange={e=>update(i,key,e.target.value)}/></label>)}</div>
    </section>)}
    <div className="shopify-variant-actions"><button type="button" onClick={()=>onChange([...rows,{options:'',sku:'',price:'',quantity:''}])}>＋ 添加销售规格</button>{rows.length>0&&<button type="button" onClick={()=>onChange([])}>清空规格，使用单一规格</button>}</div>
  </div>;
}
