'use client';
import { useState } from 'react';
import type { ListingFieldDefinition } from '@/lib/domain/listing';
import type { ShopifyVariantRow } from '@/lib/platforms/shopify-integrated';
export function ShopifyLookupEditor({field,value,onChange}:{field:ListingFieldDefinition;value:unknown;onChange:(v:unknown)=>void}) {
  const [query,setQuery]=useState('');const [options,setOptions]=useState<Array<{value:string;label:string}>>([]);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const search=async()=>{setBusy(true);setError('');try{const r=await fetch(`/api/integrations/shopify-options?kind=${field.lookup}&q=${encodeURIComponent(query)}`);const d=await r.json() as {options:Array<{value:string;label:string}>;error?:string};if(!r.ok)throw new Error(d.error);setOptions(d.options);if(!d.options.length)setError('未找到匹配项，可换一个关键词（分类支持英文搜索）');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div><div style={{display:'flex',gap:8}}>{field.lookup!=='locations'&&<input aria-label="搜索关键词" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索实际店铺选项"/>}<button type="button" onClick={search} disabled={busy}>{busy?'读取中…':'读取选项'}</button></div><select aria-label={field.label} multiple={field.type==='string_array'} value={field.type==='string_array'?(Array.isArray(value)?value:[]):String(value??'')} onChange={e=>onChange(field.type==='string_array'?Array.from(e.target.selectedOptions).map(o=>o.value):e.target.value)}><option value="">暂不设置</option>{Boolean(value)&&!options.some(o=>o.value===value)&&!Array.isArray(value)&&<option value={String(value)}>{String(value)}</option>}{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>{error&&<p role="alert">{error}</p>}</div>;
}
export function ShopifyVariantsEditor({value,onChange}:{value:unknown;onChange:(v:unknown)=>void}) {
  const rows:ShopifyVariantRow[]=Array.isArray(value)?value:[];
  const update=(i:number,key:string,v:string)=>onChange(rows.map((r,j)=>j===i?{...r,[key]:v}:r));
  return <div>{rows.map((row,i)=><fieldset key={i} style={{margin:'12px 0',padding:12,border:'1px solid #dbe3df'}}><legend>规格 {i+1}</legend>{([['options','规格（颜色=红色；尺码=M）'],['sku','SKU'],['price','售价（店铺币种）'],['quantity','所选地点库存'],['barcode','条码（可选）'],['weight','运输重量 kg']] as const).map(([key,label])=><label key={key} style={{display:'block',marginBottom:6}}>{label}<input aria-label={`规格${i+1} ${label}`} value={row[key]??''} onChange={e=>update(i,key,e.target.value)}/></label>)}<button type="button" onClick={()=>onChange(rows.filter((_,j)=>j!==i))}>删除此规格</button></fieldset>)}<button type="button" onClick={()=>onChange([...rows,{options:'',sku:'',price:'',quantity:''}])}>添加实际销售规格</button></div>;
}
