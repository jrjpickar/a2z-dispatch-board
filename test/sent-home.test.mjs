import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateJob } from '../lib/state.mjs';
import { workflows, webhookUrl } from '../lib/effects.mjs';
const job = { version: 2, active: true, data: { reportDate: '2026-10-06', reportTime: '07:00', crew: [{ name: 'Ana', id: 'a', phone: '+15555550100' }, { name: 'Bob', id: 'b', phone: '+15555550101' }] } };
test('send home releases only that worker and records the hours', () => {
  const next = mutateJob(job, { action: 'send_home', hoursWorked: 4.5, sentHomeBy: 'Sam', removedWorkers: [{ contactId: 'a', workerName: 'Ana', workerPhone: '+15555550100' }] });
  assert.deepEqual(next.data.crew.map(w => w.name), ['Bob']);
  assert.equal(next.data.sentHome.length, 1);
  assert.equal(next.data.sentHome[0].name, 'Ana'); assert.equal(next.data.sentHome[0].hoursWorked, 4.5); assert.equal(next.data.sentHome[0].by, 'Sam'); assert.equal(next.data.sentHome[0].reportDate, '2026-10-06');
});
test('send home needs valid hours and a worker who is still on the job', () => {
  const ana = [{ contactId: 'a', workerName: 'Ana' }];
  for (const hoursWorked of [0, -1, 25, 'x', 1.1]) assert.throws(() => mutateJob(job, { action: 'send_home', hoursWorked, removedWorkers: ana }), /hours worked/);
  assert.throws(() => mutateJob(job, { action: 'send_home', hoursWorked: 2, removedWorkers: [{ contactId: 'z', workerName: 'Zed' }] }), /not on this job/);
  assert.throws(() => mutateJob(job, { action: 'send_home', hoursWorked: 2, removedWorkers: [] }), /Pick the worker/);
});
test('worker sent home posts to its own Make webhook', () => {
  delete process.env.WORKER_SENT_HOME_WEBHOOK;
  assert.ok(workflows.worker_sent_home);
  assert.equal(webhookUrl('worker_sent_home'), 'https://hook.us2.make.com/mo2wtttzdfhpl4liym6c8uw3pbq6mmth');
});
