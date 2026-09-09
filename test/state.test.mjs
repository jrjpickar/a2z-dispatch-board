import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateJob, mutateMove, checkVersion, normalizePayload } from '../lib/state.mjs';
import { authorizeWrite } from '../lib/http.mjs';
import { scheduleFields, searchOpportunities } from '../lib/ghl.mjs';
import { signDriverToken, verifyDriverToken, matchesDriver, matchesWorker } from '../lib/driver-token.mjs';
const times = { reportDate: '2026-09-09', reportTime: '08:00', reportEndDate: '2026-09-09', reportEndTime: '17:00' };
const job = { version: 4, active: true, data: { ...times, crew: [{ name: 'Ana', id: 'a', phone: '+15555550100' }], scopeOfWork: 'Keep this', monetaryValue: 400 } };
test('saving times does not overwrite crew or details from another dispatcher', () => {
  const next = mutateJob(job, { action: 'save_times', ...times, reportTime: '09:00', crew: 'stale worker', scopeOfWork: 'stale scope' });
  assert.deepEqual(next.data.crew, job.data.crew); assert.equal(next.data.scopeOfWork, 'Keep this'); assert.equal(next.data.reportTime, '09:00');
});
test('crew additions and removals preserve identity and unrelated fields', () => {
  let next = mutateJob(job, { action: 'assign', crewChanges: [{ contactId: 'b', workerName: 'Bob', workerPhone: '+15555550101' }], reportTime: 'old' });
  assert.equal(next.data.crew.length, 2); assert.equal(next.data.reportTime, '08:00');
  next = mutateJob({ ...job, data: next.data }, { action: 'remove', removedWorkers: [{ contactId: 'a', workerName: 'Ana' }] });
  assert.deepEqual(next.data.crew.map(w => w.id), ['b']);
});
test('legacy crew snapshots cannot silently overwrite a modern assignment', () => assert.throws(() => mutateJob(job, { action: 'assign', crew: 'other' }), /Refresh/));
test('reset clears crew and every schedule field but keeps details', () => {
  const next = mutateJob(job, { action: 'reset_dispatch', ...times, crew: 'old' });
  assert.deepEqual(next.data.crew, []); for (const key of Object.keys(times)) assert.equal(next.data[key], '');
  assert.equal(next.data.scopeOfWork, 'Keep this'); assert.equal(next.data.monetaryValue, 400); assert.equal(next.active, true);
});
test('empty details and zero value survive', () => {
  const next = mutateJob(job, { action: 'update_details', scopeOfWork: '', toolsRequired: [], monetaryValue: 0 });
  assert.equal(next.data.scopeOfWork, ''); assert.deepEqual(next.data.toolsRequired, []); assert.equal(next.data.monetaryValue, 0);
});
test('complete/cancel cannot be undone by a later stale action or implicit active default', () => {
  const next = mutateJob(job, { action: 'complete' }); assert.equal(next.active, false);
  assert.throws(() => mutateJob({ ...job, ...next }, { action: 'save_times', ...times }), /closed/);
});
test('version checks reject missing versions and concurrent edits', () => {
  assert.throws(() => checkVersion(job, {}), e => e.status === 428);
  assert.throws(() => checkVersion(job, { expectedVersion: 3 }), e => e.status === 409);
  checkVersion(job, { expectedVersion: 4 }); checkVersion(undefined, { expectedVersion: 0 });
});
test('invalid calendar dates and reversed times are rejected', () => {
  assert.throws(() => mutateJob(job, { action: 'save_times', ...times, reportDate: '2026-02-30' }), /calendar/);
  assert.throws(() => mutateJob(job, { action: 'save_times', ...times, reportEndTime: '07:00' }), /after/);
});
test('embedded legacy JSON is normalized without numeric keys', () => {
  assert.deepEqual(normalizePayload({ 0: '{"jobId":"a","crew":"Ana"}', scopeOfWork: 'x' }), { jobId: 'a', crew: 'Ana', scopeOfWork: 'x' });
});
test('logistics reset clears every fallback schedule/driver/asset field', () => {
  const next = mutateMove({ data: { sourceOpportunityId: 'parent', notes: 'keep', ...times, scheduledDate: '2026-09-09', requestedDate: '2026-09-09', date: '2026-09-09', scheduledStart: '2026-09-09T08:00', driverName: 'Joe', driver: { name: 'Joe' }, assetId: 'truck1', assets: [{ assetId: 'truck2' }] } }, { action: 'reset_dispatch' });
  for (const key of ['reportDate','scheduledDate','requestedDate','date','scheduledStart','driverName','assetId']) assert.equal(next.data[key], '');
  assert.equal(next.data.driver, null); assert.deepEqual(next.data.assets, []); assert.equal(next.data.notes, 'keep');
  assert.deepEqual(new Set(next.data.releasedAssetIds), new Set(['truck1', 'truck2']));
});
test('driver-only mutations cannot rewrite schedules, assets or parent identity', () => {
  const next = mutateMove({ data: { sourceOpportunityId: 'parent', scheduledDate: '2026-09-09', assets: [{ assetId: 'truck' }] } }, { action: 'assign_driver', driverName: 'Joe', scheduledDate: 'old', assets: [], sourceOpportunityId: 'wrong' });
  assert.equal(next.data.sourceOpportunityId, 'parent'); assert.equal(next.data.scheduledDate, '2026-09-09'); assert.equal(next.data.assets.length, 1);
});
test('move creation/import cannot overwrite an existing row', () => assert.throws(() => mutateMove({ data: {} }, { action: 'create', notes: 'old' }), /already exists/));
test('write authorization rejects cross-site and anonymous machine requests', () => {
  delete process.env.STATE_SYNC_TOKEN;
  assert.throws(() => authorizeWrite(new Request('https://board.test/api/shared-state', { method: 'POST' })), e => e.status === 403);
  assert.throws(() => authorizeWrite(new Request('https://board.test/api/shared-state', { headers: { origin: 'https://evil.test' } })), e => e.status === 403);
  authorizeWrite(new Request('https://board.test/api/shared-state', { headers: { origin: 'https://board.test' } }));
  process.env.STATE_SYNC_TOKEN = 'test-only-token';
  authorizeWrite(new Request('https://board.test/api/shared-state', { headers: { authorization: 'Bearer test-only-token' } }));
  delete process.env.STATE_SYNC_TOKEN;
});
test('GHL reset writes explicit empty custom fields', () => assert.ok(scheduleFields({}).every(f => f.field_value === '')));
test('stops become the route source of truth and legacy pickup/destination stay in sync', () => {
  const next = mutateMove({ data: {} }, { action: 'update_stops', stops: [{ address: 'A2Z Yard', type: 'pickup' }, { address: '123 Main St' }] });
  assert.equal(next.data.stops.length, 2);
  assert.equal(next.data.pickupAddress, 'A2Z Yard');
  assert.equal(next.data.destinationAddress, '123 Main St');
  assert.ok(next.data.stops.every(s => s.id));
  assert.equal(next.data.stops[1].type, 'stop');
});
test('stops require an address; an empty route is rejected', () => {
  assert.throws(() => mutateMove({ data: {} }, { action: 'update_stops', stops: [{ address: '' }] }), /needs an address/);
  assert.throws(() => mutateMove({ data: {} }, { action: 'update_stops', stops: [] }), /At least one stop/);
});
test('editing an existing move can replace its stops via update_job/update_addon', () => {
  const created = mutateMove(undefined, { action: 'create', stops: [{ address: 'First' }] });
  const edited = mutateMove({ data: created.data }, { action: 'update_job', stops: [{ address: 'First' }, { address: 'Second' }], scheduledDate: '2026-09-09', scheduledTime: '08:00' });
  assert.equal(edited.data.stops.length, 2);
  assert.equal(edited.data.destinationAddress, 'Second');
});
test('toggle_stop only flips the matching stop\'s completion, nothing else', () => {
  const created = mutateMove({ data: {} }, { action: 'update_stops', stops: [{ address: 'A' }, { address: 'B' }] });
  const stopId = created.data.stops[1].id;
  const toggled = mutateMove({ data: created.data }, { action: 'toggle_stop', stopId, completed: true, completedBy: 'Joe' });
  assert.ok(toggled.data.stops[1].completedAt);
  assert.equal(toggled.data.stops[1].completedBy, 'Joe');
  assert.equal(toggled.data.stops[0].completedAt, '');
  const untoggled = mutateMove({ data: toggled.data }, { action: 'toggle_stop', stopId, completed: false });
  assert.equal(untoggled.data.stops[1].completedAt, '');
});
test('toggle_stop on an unknown stop id is rejected', () => {
  const created = mutateMove({ data: {} }, { action: 'update_stops', stops: [{ address: 'A' }] });
  assert.throws(() => mutateMove({ data: created.data }, { action: 'toggle_stop', stopId: 'nope' }), e => e.status === 404);
});
test('driver tokens verify only with the right secret and before expiry', () => {
  process.env.DRIVER_TOKEN_SECRET = 'test-only-secret';
  const token = signDriverToken({ driverKey: 'phone:5551234567', name: 'Joe', phone: '5551234567' }, 60);
  const payload = verifyDriverToken(token);
  assert.equal(payload.name, 'Joe');
  assert.equal(verifyDriverToken(token + 'x'), null);
  assert.equal(verifyDriverToken(signDriverToken({ driverKey: 'phone:1' }, -10)), null);
  delete process.env.DRIVER_TOKEN_SECRET;
});
test('driver/worker identity matching is phone-first with a name fallback', () => {
  const identity = { name: 'Joe Smith', phone: '5551234567' };
  assert.ok(matchesDriver({ driverPhone: '(555) 123-4567' }, identity));
  assert.ok(matchesDriver({ driverName: 'joe smith' }, identity));
  assert.ok(!matchesDriver({ driverName: 'Bob' }, identity));
  assert.ok(matchesWorker({ crew: [{ name: 'Joe Smith' }] }, identity));
  assert.ok(!matchesWorker({ crew: [{ name: 'Bob' }] }, identity));
});
test('GHL pagination collects all pages and does not silently truncate', async () => {
  const original = globalThis.fetch; const urls = []; process.env.GHL_API_TOKEN = 'fake';
  globalThis.fetch = async url => { urls.push(String(url)); const page = new URL(url).searchParams.get('page'); return Response.json({ opportunities: page === '1' ? Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) : [{ id: '100' }] }); };
  try { const list = await searchOpportunities('fake', 'loc', 'pipe'); assert.equal(list.length, 101); assert.equal(urls.length, 2); } finally { globalThis.fetch = original; delete process.env.GHL_API_TOKEN; }
});
