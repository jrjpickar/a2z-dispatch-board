// Labor board: logistics assets (trucks, trailers, equipment) given to a crew member.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateJob } from '../lib/state.mjs';
const times = { reportDate: '2026-11-10', reportTime: '07:00', reportEndDate: '2026-11-10', reportEndTime: '15:30' };
const ANA = { id: 'a', name: 'Ana Lopez', phone: '+15555550100' }, BOB = { id: 'b', name: 'Bob Ray', phone: '+15555550101' };
const job = (data = {}) => ({ version: 1, active: true, data: { ...times, crew: [ANA, BOB], ...data } });
const give = (w, assets, cur = job()) => mutateJob(cur, { action: 'set_worker_asset', contactId: w.id, workerName: w.name, workerPhone: w.phone, assets, assignedBy: 'Jesse' });

test('set_worker_asset saves, replaces and clears one worker\'s assets without touching the others', () => {
  let r = give(ANA, [{ assetId: 't1', assetName: 'Truck 12' }, { assetId: 't1', assetName: 'dup' }, { assetId: 'e3', assetName: 'Trailer 16ft' }]);
  assert.deepEqual(r.data.workerAssets.map(a => [a.workerName, a.assetId]), [['Ana Lopez', 't1'], ['Ana Lopez', 'e3']]);
  assert.equal(r.data.workerAssets[0].by, 'Jesse');
  r = give(BOB, [{ assetId: 't7', assetName: 'Truck 7' }], { ...job(), data: r.data });
  r = give(ANA, [{ assetId: 'e3', assetName: 'Trailer 16ft' }], { ...job(), data: r.data });
  assert.deepEqual(r.data.workerAssets.map(a => [a.workerName, a.assetId]), [['Bob Ray', 't7'], ['Ana Lopez', 'e3']]);
  assert.deepEqual(r.data.crew, [ANA, BOB], 'crew untouched');
  r = give(BOB, [], { ...job(), data: r.data });
  assert.deepEqual(r.data.workerAssets.map(a => a.workerName), ['Ana Lopez']);
});

test('a worker not on the job, too many assets, or a closed job is refused', () => {
  assert.throws(() => give({ id: 'z', name: 'Zed', phone: '' }, [{ assetId: 't1' }]), /not on this job/);
  assert.throws(() => give(ANA, [1, 2, 3, 4, 5, 6].map(n => ({ assetId: 't' + n }))), /Up to 5/);
  assert.throws(() => give(ANA, [{ assetId: 't1' }], { version: 2, active: false, data: job().data }), /closed/);
});

test('assets leave with the worker: remove, send home, reset day and complete clear them', () => {
  const withAssets = () => ({ ...job(), data: give(BOB, [{ assetId: 't7', assetName: 'Truck 7' }], { ...job(), data: give(ANA, [{ assetId: 't1', assetName: 'Truck 12' }]).data }).data });
  let r = mutateJob(withAssets(), { action: 'remove', removedWorkers: [{ contactId: 'a', workerName: 'Ana Lopez', workerPhone: ANA.phone }] });
  assert.deepEqual(r.data.workerAssets.map(a => a.workerName), ['Bob Ray']);
  r = mutateJob(withAssets(), { action: 'send_home', workerName: 'Bob Ray', hoursWorked: 4, removedWorkers: [{ contactId: 'b', workerName: 'Bob Ray', workerPhone: BOB.phone }] });
  assert.deepEqual(r.data.workerAssets.map(a => a.workerName), ['Ana Lopez']);
  assert.equal(mutateJob(withAssets(), { action: 'reset_dispatch' }).data.workerAssets, undefined);
  assert.equal(mutateJob(withAssets(), { action: 'cancel' }).data.workerAssets, undefined);
  // Unrelated saves keep them.
  assert.equal(mutateJob(withAssets(), { action: 'save_times', ...times, reportTime: '08:00' }).data.workerAssets.length, 2);
});
