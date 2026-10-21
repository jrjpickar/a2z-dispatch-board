import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '../lib/session.mjs';
process.env.SESSION_SECRET = 'resubmit-test-secret';
let called = 0;
const sql = async strings => strings.join('').includes('dispatch_admins') ? [{ok:1}] : [];
mock.module('../netlify/functions/db.mjs', { namedExports: { db:()=>sql, ensureSchema:async()=>{} } });
mock.module('../lib/webhook-resubmit.mjs', { namedExports: { resubmitWorkflow:async()=>{called++;return {ok:true};} } });
const { default: handler } = await import('../netlify/functions/senior.mjs');
const request = user => new Request('https://board.test/api/senior', {method:'POST', headers:{origin:'https://board.test','content-type':'application/json', ...(user ? {'x-a2z-session':signSession(user,'ghl_sso')} : {})},body:JSON.stringify({action:'resubmit_effect',effectId:'eod1',requestId:'resubmit-test-000001'})});
test('resubmit endpoint refuses signed-out callers and regular admins',async()=>{
  assert.equal((await handler(request())).status,401);
  assert.equal((await handler(request({id:'ordinary',name:'Ordinary Admin',email:'ordinary@example.com'}))).status,403);
  assert.equal(called,0);
});
test('resubmit endpoint allows an authenticated senior admin',async()=>{
  const response=await handler(request({id:'senior',name:'Jesse Pickar',email:'jesse@a2zcs.net'}));
  assert.equal(response.status,200);assert.equal(called,1);
});
