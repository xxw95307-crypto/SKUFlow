import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { identityFromHeaders, resourceReferences } from '../lib/domain/identity.ts';

test('identity requires server-supplied id and email; decodes optional name safely', () => {
  assert.equal(identityFromHeaders(new Headers()), null);
  assert.equal(identityFromHeaders(new Headers({ 'oai-authenticated-user-id': 'user-a' })), null);
  const headers = new Headers({ 'oai-authenticated-user-id': 'user-a', 'oai-authenticated-user-email': 'a@example.com', 'oai-authenticated-user-full-name': encodeURIComponent('真实用户'), 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' });
  assert.equal(identityFromHeaders(headers)?.name, '真实用户');
  headers.set('oai-authenticated-user-full-name', '%broken');
  assert.equal(identityFromHeaders(headers)?.name, 'a@example.com');
});

test('ownership references include media downloads, task linking and nested attachments', () => {
  const refs = resourceReferences('https://example.com/api/tasks/task-a/videos/video-a/file?conversationId=conversation-a', { taskId:'task-b', messages:[{ attachments:[{ taskId:'task-c' }] }] });
  assert.deepEqual(refs, [{kind:'task',id:'task-a'},{kind:'task',id:'task-b'},{kind:'task',id:'task-c'},{kind:'conversation',id:'conversation-a'}]);
});

test('API boundary rejects anonymous and other users before executing handler', async () => {
  const owners = new Set(['task:task-a:user-a','conversation:conversation-a:user-a']);
  const DB = { prepare: () => ({ bind: (...values: string[]) => ({ first: async () => owners.has(values.join(':')) ? {ok:1} : null }) }) };
  const source = readFileSync(new URL('../lib/server/auth.ts', import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
  const js = stripTypeScriptTypes(source,{mode:'strip'});
  (globalThis as any).__authTest = { headers:async()=>new Headers(), ensureSchema:async()=>{}, getBindings:()=>({DB}), identityFromHeaders, resourceReferences };
  const mod = await import('data:text/javascript;base64,'+Buffer.from('const {headers,ensureSchema,getBindings,identityFromHeaders,resourceReferences}=globalThis.__authTest;\n'+js).toString('base64'));
  let calls=0;
  const run=mod.withAuthentication(async()=>{ calls++;return Response.json({ok:true}); });
  const signed = { 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com' };
  assert.equal((await run(new Request('https://example.com/api/tasks/task-a'))).status,401);
  assert.equal((await run(new Request('https://example.com/api/tasks/task-b',{headers:signed}))).status,404);
  assert.equal((await run(new Request('https://example.com/api/tasks/task-a',{headers:{...signed,'oai-authenticated-user-id':'user-b'}}))).status,404);
  assert.equal(calls,0);
  assert.equal((await run(new Request('https://example.com/api/conversations/conversation-a',{method:'PATCH',headers:{...signed,'content-type':'application/json'},body:JSON.stringify({taskId:'task-b'})}))).status,404);
  assert.equal((await run(new Request('https://example.com/api/tasks/task-a',{method:'POST',headers:{...signed,origin:'https://evil.example'}}))).status,403);
  assert.equal(calls,0);
  const response=await run(new Request('https://example.com/api/tasks/task-a',{headers:signed}));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(calls,1);
});

test('every API route exports only authenticated handlers', () => {
  const walk=(directory:URL):URL[]=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(new URL(entry.name+'/',directory)):entry.name==='route.ts'?[new URL(entry.name,directory)]:[]);
  for(const file of walk(new URL('../app/api/',import.meta.url))) {
    if (file.pathname.includes('/app/api/auth/')) continue;
    const source=readFileSync(file,'utf8');
    assert.doesNotMatch(source,/export async function (GET|POST|PATCH|PUT|DELETE)/,file.pathname);
    assert.match(source,/export const (GET|POST|PATCH|PUT|DELETE) = withAuthentication\(/,file.pathname);
  }
});
