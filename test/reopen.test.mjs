import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateJob } from '../lib/state.mjs';
const times = { reportDate: '2026-10-05', reportTime: '07:00', reportEndDate: '2026-10-05', reportEndTime: '15:30' };
const open = { version: 3, active: true, data: { ...times, crew: [{ name: 'Ana', id: 'a', phone: '' }], scopeOfWork: 'Demo' } };
test('a closed job refuses crew and schedule changes with a message that points at Reopen job', () => {
  const closed = mutateJob(open, { action: 'complete', closedBy: 'Sam' });
  assert.equal(closed.active, false); assert.equal(closed.data.closedBy, 'Sam'); assert.ok(closed.data.closedAt);
  const cur = { version: 4, ...closed };
  assert.throws(() => mutateJob(cur, { action: 'assign', crewChanges: [{ name: 'Bob' }] }), /Reopen job/);
  assert.throws(() => mutateJob(cur, { action: 'save_times', ...times }), /Reopen job/);
});
test('reopen makes the job editable again, keeps times and details, and clears the closed status', () => {
  const closed = mutateJob(open, { action: 'cancel' });
  const reopened = mutateJob({ version: 4, ...closed }, { action: 'reopen', reopenedBy: 'Jesse' });
  assert.equal(reopened.active, true); assert.equal(reopened.data.status, undefined); assert.equal(reopened.data.reopenedBy, 'Jesse');
  assert.equal(reopened.data.reportDate, '2026-10-05'); assert.equal(reopened.data.scopeOfWork, 'Demo'); assert.deepEqual(reopened.data.crew, []);
  const assigned = mutateJob({ version: 5, ...reopened }, { action: 'assign', crewChanges: [{ name: 'Bob' }] });
  assert.deepEqual(assigned.data.crew.map(w => w.name), ['Bob']);
});
test('closing keeps the job name, client and value for the Completed tab', () => {
  const closed = mutateJob(open, { action: 'complete', jobAddress: '55 Elm St', clientName: 'Acme', monetaryValue: 1200 });
  assert.equal(closed.data.closedJobName, '55 Elm St'); assert.equal(closed.data.closedClientName, 'Acme'); assert.equal(closed.data.monetaryValue, 1200);
  const kept = mutateJob({ ...open, data: { ...open.data, monetaryValue: 900 } }, { action: 'cancel', monetaryValue: 1200 });
  assert.equal(kept.data.monetaryValue, 900);
});
