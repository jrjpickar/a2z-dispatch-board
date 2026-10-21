import test from 'node:test';
import assert from 'node:assert/strict';
import { resubmitWorkflow } from '../lib/webhook-resubmit.mjs';
const admin = { uid: 'senior', name: 'Senior Admin' };
const payload = { action: 'eod_sheet', jobId: 'job1', date: '2026-10-20', crew: [{ name: 'Ana', hours: 7 }] };
function fixture(status = 'confirmed') {
  const rows = new Map([['original', {effect_id:'original', kind:'eod_sheet', status, payload:structuredClone(payload), updated_at:new Date()}]]);
  const audit = []; let chain = Promise.resolve();
  const sql = async (strings, ...v) => {
    const q = strings.join('?').replace(/\s+/g,' ').trim();
    if (q.startsWith('select pg_advisory')) return [];
    if (q.startsWith('select * from dispatch_effects')) return rows.has(v[0]) ? [structuredClone(rows.get(v[0]))] : [];
    if (q.startsWith('select data from project_schedules')) return [{data:{jobId:v[0], start:'2026-10-22', phases:[{on:true, crew:4, days:2}]}}];
    if (q.startsWith('select effect_id from dispatch_effects')) return [...rows.values()].filter(r=>r.request_id===v[0] && r.status==='sending');
    if (q.startsWith('insert into dispatch_effects')) { rows.set(v[0],{effect_id:v[0],request_id:v[1],kind:v[2],fingerprint:v[3],status:'sending',payload:structuredClone(v[4]),updated_at:new Date()});return []; }
    if (q.startsWith('insert into dispatch_activity')) { audit.push(v);return []; }
    throw new Error('Unexpected query: '+q);
  };
  sql.json = v => v;
  sql.begin = cb => { const next = chain.then(()=>cb(sql)); chain=next.catch(()=>{}); return next; };
  const sent=[];
  const deliver = async (_sql,row) => {sent.push(structuredClone(row)); rows.get(row.effect_id).status='confirmed';return true;};
  return {sql,rows,audit,sent,deliver};
}
const body = (requestId = 'resubmit-request-0001') => ({action:'resubmit_effect',effectId:'original',requestId});
test('resubmits confirmed EOD using original payload and a new event ID; audits the actor',async()=>{
  const f=fixture(); const result=await resubmitWorkflow(f.sql,body(),admin,{deliver:f.deliver});
  assert.equal(result.ok,true); assert.notEqual(result.effectId,'original');
  assert.deepEqual(f.sent[0].payload,payload); assert.equal(f.sent[0].kind,'eod_sheet');
  assert.equal(f.audit.length,2); assert.equal(f.audit[0][1],admin.name);
  assert.equal(f.rows.get('original').status,'confirmed');
});
test('lost-reply retry reuses the request without sending again',async()=>{
  const f=fixture(); await resubmitWorkflow(f.sql,body(),admin,{deliver:f.deliver});
  const again=await resubmitWorkflow(f.sql,body(),admin,{deliver:f.deliver});
  assert.equal(again.replayed,true);assert.equal(again.ok,true);assert.equal(f.sent.length,1);
});
test('two admins cannot resubmit the same run while a resubmission is in flight',async()=>{
  const f=fixture(); let release; const waiting=new Promise(r=>release=r);
  const first=resubmitWorkflow(f.sql,body(),admin,{deliver:async()=>{await waiting;return true;}});
  while(!f.rows.has('resubmit:resubmit-request-0001')) await new Promise(r=>setTimeout(r,1));
  await assert.rejects(resubmitWorkflow(f.sql,body('resubmit-request-0002'),admin,{deliver:f.deliver}),/already sending/);
  release();await first;
});
test('waiting/cancelled/in-progress originals cannot be resubmitted',async()=>{
  for(const status of ['scheduled','cancelled','sending']) {const f=fixture(status);await assert.rejects(resubmitWorkflow(f.sql,body(),admin,{deliver:f.deliver}),/waiting|still sending/);assert.equal(f.sent.length,0);}
});
test('stale failed and acknowledged runs remain resubmittable',async()=>{
  for(const status of ['uncertain','confirmed','sending']) {const f=fixture(status);f.rows.get('original').updated_at=new Date(Date.now()-120000);assert.equal((await resubmitWorkflow(f.sql,body(),admin,{deliver:f.deliver})).ok,true);}
});
test('missing payload is refused and arbitrary browser payload is ignored',async()=>{
  const f=fixture();f.rows.get('original').payload=null;
  await assert.rejects(resubmitWorkflow(f.sql,{...body(),payload},admin,{deliver:f.deliver}),/unavailable/);
});
test('latest saved Project Schedule can be resubmitted without a dispatch mutation',async()=>{
  const f=fixture();const result=await resubmitWorkflow(f.sql,{action:'resubmit_schedule',jobId:'job1',requestId:'schedule-request-0001'},admin,{deliver:f.deliver});
  assert.equal(result.ok,true);assert.equal(f.sent[0].kind,'project_schedule');assert.equal(f.sent[0].payload.start,'2026-10-22');
});
test('failed delivery is returned as uncertain rather than silently confirmed',async()=>{
  const f=fixture();const result=await resubmitWorkflow(f.sql,body(),admin,{deliver:async()=>false});
  assert.equal(result.ok,false);assert.equal(result.status,'uncertain');assert.match(result.error,/not confirmed/);
});
