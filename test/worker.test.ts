import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { LIMITS } from '../src/index';
const token = 'test-upload-token-'.repeat(4), statusToken = 'test-status-token-'.repeat(4);
const bytes = new TextEncoder().encode('age-encryption.org/v1\nTEST-CIPHERTEXT');
async function request(id = crypto.randomUUID(), body = bytes, extra = {}) {
 const digest = await crypto.subtle.digest('SHA-256', body);
 const sha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
 return new Request('https://backup.test/upload', {method:'POST',body,headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','content-length':String(body.length),'x-backup-id':id,'x-backup-sha256':sha,...extra}});
}
function isolated() {
 const gate = env.GATE.get(env.GATE.newUniqueId());
 return {...env,UPLOAD_TOKEN:token,STATUS_TOKEN:statusToken,GATE:{getByName:()=>gate}};
}
describe('backup admission', () => {
 it('rejects unauthenticated requests and does not expose read/delete/reconcile', async()=>{
  const e=isolated();
  expect((await worker.fetch(new Request('https://x/upload',{method:'POST'}),e)).status).toBe(401);
  for(const path of ['/reconcile','/delete','/objects/a']) expect((await worker.fetch(new Request(`https://x${path}`,{method:'POST'}),e)).status).toBe(404);
  expect((await worker.fetch(new Request('https://x/status',{headers:{authorization:`Bearer ${token}`}}),e)).status).toBe(401);
 });
 it('stores exact ciphertext once; a retry returns a receipt without rewriting', async()=>{
  const e=isolated(), id=crypto.randomUUID();
  const first=await worker.fetch(await request(id),e);expect(first.status).toBe(201);
  const receipt=await first.json();
  const stored=await env.BACKUPS.get(receipt.key);expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
  const second=await worker.fetch(await request(id),e);expect(second.status).toBe(200);expect((await second.json()).duplicate).toBe(true);
  const status=await worker.fetch(new Request('https://x/status',{headers:{authorization:`Bearer ${statusToken}`}}),e);
  expect((await status.json()).reserved_bytes).toBe(bytes.length);
 });
 it('rejects oversize before storing and fails closed on a dishonest body length',async()=>{
  const e=isolated();
  expect((await worker.fetch(await request(undefined,bytes,{'content-length':String(LIMITS.object+1)}),e)).status).toBe(413);
  expect((await worker.fetch(await request(undefined,bytes,{'content-length':String(bytes.length+1)}),e)).status).toBe(400);
 });
 it('checks encryption framing and checksums; failures also consume the daily quota',async()=>{
  const e=isolated();
  expect((await worker.fetch(await request(undefined,new TextEncoder().encode('PLAINTEXT'.repeat(5))),e)).status).toBe(400);
  expect((await worker.fetch(await request(undefined,bytes,{'x-backup-sha256':'0'.repeat(64)}),e)).status).toBe(400);
  expect((await worker.fetch(await request(),e)).status).toBe(201);
  expect((await worker.fetch(await request(),e)).status).toBe(429);
 });
 it('does not allow concurrent uploads to bypass reservations',async()=>{
  const e=isolated();
  const requests=await Promise.all(Array.from({length:12},()=>request()));
  const results=await Promise.all(requests.map(r=>worker.fetch(r,e)));
  expect(results.filter(r=>r.status===201).length).toBeLessThanOrEqual(3);
  expect(results.every(r=>[201,409,429].includes(r.status))).toBe(true);
  const s=await worker.fetch(new Request('https://x/status',{headers:{authorization:`Bearer ${statusToken}`}}),e);
  expect((await s.json()).reserved_bytes).toBeLessThanOrEqual(bytes.length*3);
 });
});

describe('persistent capacity and read budgets', () => {
 it('rejects a full capacity ledger before calling R2', async () => {
  const e=isolated();
  await runInDurableObject(e.GATE.getByName(), async (_,state) => {
   await state.storage.put('ledger',{entries:[{id:'full',key:'full',bytes:LIMITS.stored,at:Date.now(),status:'complete'}],day:'',attempts:0,lastSuccess:null});
  });
  expect((await worker.fetch(await request(),e)).status).toBe(429);
 });
 it('does not release retained objects and persists the HEAD limit across requests', async () => {
  const e=isolated(), key=`retained-${crypto.randomUUID()}`;
  await env.BACKUPS.put(key,bytes);
  await runInDurableObject(e.GATE.getByName(), async (_,state) => {
   await state.storage.put('ledger',{entries:[{id:'old',key,bytes:bytes.length,at:0,status:'complete'}],day:'',attempts:0,lastSuccess:null});
  });
  await e.GATE.getByName().fetch('https://internal/reconcile');
  await runInDurableObject(e.GATE.getByName(), async (_,state) => {
   const l=await state.storage.get('ledger');expect(l.entries).toHaveLength(1);expect(l.heads).toBe(1);
   l.heads=LIMITS.headsDaily;await state.storage.put('ledger',l);
  });
  await env.BACKUPS.delete(key);
  await e.GATE.getByName().fetch('https://internal/reconcile');
  await runInDurableObject(e.GATE.getByName(), async (_,state) => {
   const l=await state.storage.get('ledger');expect(l.entries).toHaveLength(1);expect(l.heads).toBe(LIMITS.headsDaily);
   l.headDay='2000-01-01';await state.storage.put('ledger',l);
  });
  await e.GATE.getByName().fetch('https://internal/reconcile');
  await runInDurableObject(e.GATE.getByName(), async (_,state) => {
   const l=await state.storage.get('ledger');expect(l.entries).toHaveLength(0);expect(l.heads).toBe(1);
  });
 });
});
