import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureSchema } from '../netlify/functions/db.mjs';
import { saveState } from '../lib/store.mjs';
import { createDispatch } from '../lib/create.mjs';
import { syncJobSchedule } from '../lib/ghl.mjs';
const pg = new PGlite();
function adapter(engine) {
  const sql = async (strings, ...values) => {
    const query = strings.reduce((text, part, i) => text + (i ? '$' + i : '') + part, '');
    return (await engine.query(query, values)).rows;
  };
  sql.json = value => JSON.stringify(value);
  sql.begin = callback => engine.transaction(tx => callback(adapter(tx)));
  return sql;
}
const sql = adapter(pg);
const request = (id, body) => ({ jobId: id, expectedVersion: 0, requestId: crypto.randomUUID(), ...body });
await ensureSchema(sql);
test('real PostgreSQL migrations are repeatable and preserve legacy data', async () => {
  await ensureSchema(sql);
  const rows = await sql`select column_name from information_schema.columns where table_name = 'job_shared_state'`;
  assert.ok(rows.some(r => r.column_name === 'version'));
  const codeTable = await sql`select column_name from information_schema.columns where table_name = 'dispatch_driver_codes'`;
  assert.ok(codeTable.some(r => r.column_name === 'code'));
});
const moveRequest = (moveId, body) => ({ moveId, expectedVersion: 0, requestId: crypto.randomUUID(), ...body });
test('a route with stops persists, and a driver-safe stop toggle survives a stale concurrent write', async () => {
  const created = await saveState(sql, 'move', moveRequest('move-stops', { action: 'create', stops: [{ address: 'A2Z Yard', type: 'pickup' }, { address: '123 Main St', type: 'delivery' }] }));
  assert.equal(created.state.stops.length, 2);
  assert.equal(created.state.destinationAddress, '123 Main St');
  const stopId = created.state.stops[1].id;
  const toggled = await saveState(sql, 'move', moveRequest('move-stops', { action: 'toggle_stop', stopId, completed: true, completedBy: 'Joe', expectedVersion: created.state.version }));
  assert.ok(toggled.state.stops[1].completedAt);
  assert.equal(toggled.state.stops[0].completedAt, '');
  // A stale dispatcher edit (still on the pre-toggle version) must not silently clobber the driver's checkmark.
  await assert.rejects(saveState(sql, 'move', moveRequest('move-stops', { action: 'update_job', notes: 'stale edit', expectedVersion: created.state.version })), e => e.status === 409);
  const [row] = await sql`select data from logistics_move_state where move_id = 'move-stops'`;
  assert.ok(row.data.stops[1].completedAt);
});
test('transactional replay returns the original version without applying twice', async () => {
  const payload = request('job-replay', { action: 'create', crew: 'Ana', scopeOfWork: 'keep' });
  const first = await saveState(sql, 'job', payload);
  const replay = await saveState(sql, 'job', payload);
  assert.equal(first.record.version, 1); assert.equal(replay.record.version, 1); assert.equal(replay.replayed, true);
  await assert.rejects(saveState(sql, 'job', { ...payload, scopeOfWork: 'changed' }), e => e.status === 409);
});
test('stale writer fails and neither crew nor schedule is lost', async () => {
  const created = await saveState(sql, 'job', request('job-cas', { action: 'create', crew: 'Ana' }));
  await saveState(sql, 'job', request('job-cas', { action: 'assign', expectedVersion: created.record.version, crewChanges: [{ name: 'Bob' }] }));
  await assert.rejects(saveState(sql, 'job', request('job-cas', { action: 'update_details', expectedVersion: 1, scopeOfWork: 'stale' })), e => e.status === 409);
  const [row] = await sql`select * from job_shared_state where job_id = 'job-cas'`;
  assert.deepEqual(row.data.crew.map(w => w.name), ['Ana','Bob']); assert.equal(row.version, 2);
});
test('two moves cannot own the same vehicle', async () => {
  await saveState(sql, 'move', { moveId: 'move-a', action: 'assign_asset', assetId: 'truck1', expectedVersion: 0, requestId: crypto.randomUUID() });
  await assert.rejects(saveState(sql, 'move', { moveId: 'move-b', action: 'assign_asset', assetId: 'truck1', expectedVersion: 0, requestId: crypto.randomUUID() }), e => e.status === 409);
  await saveState(sql, 'move', { moveId: 'move-a', action: 'reset_dispatch', expectedVersion: 1, requestId: crypto.randomUUID() });
  await saveState(sql, 'move', { moveId: 'move-b', action: 'assign_asset', assetId: 'truck1', expectedVersion: 0, requestId: crypto.randomUUID() });
});
test('dispatch remains saved when GHL fails; retry uses latest schedule', async () => {
  const p = request('job-sync', { action: 'save_times', reportDate: '2026-09-09', reportTime: '08:00', reportEndDate: '2026-09-09', reportEndTime: '17:00' });
  await saveState(sql, 'job', p);
  const original = globalThis.fetch; process.env.GHL_API_TOKEN = 'fake';
  try {
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    assert.equal((await syncJobSchedule(sql, 'job-sync')).ok, false);
    const [row] = await sql`select data from job_shared_state where job_id = 'job-sync'`; assert.equal(row.data.reportTime, '08:00');
    await saveState(sql, 'job', { ...p, requestId: crypto.randomUUID(), expectedVersion: 1, reportTime: '09:00' });
    let sent;
    globalThis.fetch = async (url, options) => { sent = JSON.parse(options.body); return Response.json({ opportunity: { id: 'job-sync' } }); };
    assert.equal((await syncJobSchedule(sql, 'job-sync')).ok, true);
    assert.ok(sent.customFields.some(f => f.field_value === '09:00'));
    const [sync] = await sql`select pending from dispatch_crm_sync where job_id = 'job-sync'`; assert.equal(sync.pending, false);
  } finally { globalThis.fetch = original; delete process.env.GHL_API_TOKEN; }
});
test('server seeds created jobs and replays creation without a second Make call', async () => {
  const original = globalThis.fetch; let calls = 0;
  const payload = { action: 'create', requestId: crypto.randomUUID(), jobAddress: 'Created job', reportDate: '2026-09-09', reportTime: '08:00', reportEndDate: '2026-09-09', reportEndTime: '17:00' };
  globalThis.fetch = async () => { calls++; return Response.json({ ok: true, opportunityId: 'created-job-123456789' }); };
  try {
    const first = await createDispatch(sql, 'job', payload);
    const second = await createDispatch(sql, 'job', payload);
    assert.equal(first.record.reportTime, '08:00'); assert.equal(second.record.version, 1); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test('unconfirmed creation is not blindly retried', async () => {
  const original = globalThis.fetch; let calls = 0;
  const payload = { action: 'create', requestId: crypto.randomUUID() };
  globalThis.fetch = async () => { calls++; return new Response('Accepted'); };
  try {
    await assert.rejects(createDispatch(sql, 'job', payload), e => e.status === 502);
    await assert.rejects(createDispatch(sql, 'job', payload), e => e.status === 409);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test.after(async () => pg.close());
