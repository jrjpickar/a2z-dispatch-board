import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateJob } from '../lib/state.mjs';
import { createDispatch } from '../lib/create.mjs';
const times = { reportDate:'2026-10-22', reportTime:'08:00', reportEndDate:'2026-10-22', reportEndTime:'17:00' };
const contract = { active:true, data:{ jobType:'contract', crew:[] } };
test('board contract creation is refused before any database or Make call', async () => {
  for (const payload of [{jobType:'contract'}, {sourceType:'demo'}, {pipelineId:'d5Ix1SlN3YpZ5gQewZUo'}]) {
    await assert.rejects(createDispatch(null, 'job', payload), /must be created in GHL or Make/);
  }
});
test('import remains available but imported configuration flags are not trusted', () => {
  const next = mutateJob(null, {action:'import', jobType:'contract', projectConfiguredAt:'forged', timesFirstLockedAt:'forged'});
  assert.equal(next.data.jobType,'contract');
  assert.equal(next.data.projectConfiguredAt,undefined);
  assert.equal(next.data.timesFirstLockedAt,undefined);
});
test('contract details must be saved before first lock; client flags cannot bypass', () => {
  assert.throws(()=>mutateJob(contract,{action:'save_times',...times,projectConfiguredAt:'forged',scheduleReady:true}),/Configure this project/);
  const configured = mutateJob(contract,{action:'update_details',crewSize:4});
  assert.ok(configured.data.projectConfiguredAt);
  assert.throws(()=>mutateJob(configured,{action:'save_times',...times,scheduleReady:true}),/Save a Project Schedule/);
  const locked = mutateJob(configured,{action:'save_times',...times},{scheduleReady:true});
  assert.ok(locked.data.timesFirstLockedAt);
  const reset = mutateJob(locked,{action:'reset_dispatch'});
  assert.ok(reset.data.timesFirstLockedAt);
  assert.ok(reset.data.projectConfiguredAt);
  assert.doesNotThrow(()=>mutateJob(reset,{action:'save_times',...times}));
});
test('GHL contract context protects jobs without imported jobType metadata', () => {
  assert.throws(()=>mutateJob({active:true,data:{}},{action:'save_times',...times},{contract:true}),/Configure/);
  const configured=mutateJob({active:true,data:{}},{action:'update_details',crewSize:3},{contract:true});
  assert.ok(configured.data.projectConfiguredAt);
  assert.throws(()=>mutateJob(configured,{action:'save_times',...times},{contract:true}),/Project Schedule/);
});
test('hourly times do not require configuration or project schedules', () => {
  assert.doesNotThrow(()=>mutateJob({active:true,data:{jobType:'hourly'}},{action:'save_times',...times}));
});
