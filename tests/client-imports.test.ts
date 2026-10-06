import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';

test('entire workspace client import graph excludes server sanitizer and Shopify connector', () => {
  const root=resolve(import.meta.dirname,'..');
  const visited=new Set<string>();
  const walk=(file:string):void=>{
    if(visited.has(file))return;
    visited.add(file);
    const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
    assert.doesNotMatch(code,/from\s+['"](?:sanitize-html|postcss|cloudflare:workers)['"]/,file);
    for(const match of code.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      const name=match[1];
      if(!name.startsWith('.')&&!name.startsWith('@/'))continue;
      const base=name.startsWith('@/')?resolve(root,name.slice(2)):resolve(dirname(file),name);
      if(name.endsWith('.css')) { assert.ok(existsSync(base),`Unresolved ${name} in ${file}`); continue; }
      const path=[base,base+'.ts',base+'.tsx',resolve(base,'index.ts')].find(p=>existsSync(p)&&/\.tsx?$/.test(p));
      assert.ok(path,`Unresolved ${name} in ${file}`);
      assert.ok(!/shopify-(integrated|dev)\.ts$/.test(path),`Client reaches server connector: ${file} -> ${path}`);
      walk(path);
    }
  };
  walk(resolve(root,'components/agent-conversation.tsx'));
  assert.ok(visited.size>10);
});
