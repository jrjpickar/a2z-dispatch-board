import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
const { mutateMove } = await import('../lib/state.mjs');
const { runLogisticsReminder, reminderFor, boardNow } = await import('../lib/logistics-reminder.mjs');
const sql = adapter(pg); await real.ensureSchema(sql);
const put = (id, data) => sql`insert into logistics_move_state (move_id, data, version) values (${id}, ${JSON.stringify(data)}, 1)`;

test('a move booked with a date and time comes in scheduled', () => {
  const { data } = mutateMove(null, { action: 'create_addon', moveId: 'm1', status: 'requested', requestedDate: '2026-10-16', requestedTime: '07:30', reportDate: '2026-10-16', reportTime: '07:30' });
  assert.equal(data.scheduledDate, '2026-10-16'); assert.equal(data.scheduledTime, '07:30'); assert.equal(data.status, 'scheduled');
  const blank = mutateMove(null, { action: 'create', moveId: 'm2', requestedDate: '', requestedTime: '' }).data;
  assert.equal(blank.status, 'requested'); assert.ok(!blank.scheduledDate);
  const imported = mutateMove(null, { action: 'import', moveId: 'm3', requestedDate: '2026-10-16', requestedTime: '07:30' }).data;
  assert.ok(!imported.scheduledDate, 'imports are left alone');
});

test('reminder lists tomorrow\'s moves missing a time, driver or vehicle and sends once at 3pm Pacific', async () => {
  const tomorrow = '2026-10-16';
  await put('a', { moveId: 'a', active: true, status: 'assigned', scheduledDate: tomorrow, scheduledTime: '07:00', driverName: 'Joe', assets: [{ assetId: 't1', assetName: 'Truck 12' }], jobAddress: '1 Ready St', movementType: 'container_drop' });
  await put('b', { moveId: 'b', active: true, status: 'scheduled', scheduledDate: tomorrow, scheduledTime: '09:30', jobAddress: '2 Elm St', movementType: 'container_swap', containerSize: '30 Yard', sourceOpportunityId: 'opp2' });
  await put('c', { moveId: 'c', active: true, status: 'requested', requestedDate: tomorrow, requestedTime: '', driverName: 'Ana', jobAddress: '3 Oak Ave' });
  await put('d', { moveId: 'd', active: false, status: 'completed', scheduledDate: tomorrow, scheduledTime: '08:00' });
  await put('e', { moveId: 'e', active: true, status: 'scheduled', scheduledDate: '2026-10-17', scheduledTime: '08:00' });
  const runs = [];
  globalThis.fetch = async (url, init) => { assert.match(String(url), /cw5dsqfr8qsr5vb9hr1rehspyl6pa3v2/); runs.push(JSON.parse(init.body)); return Response.json({ ok: true }); };
  // 3pm Pacific on Oct 15 2026 (PDT) = 22:00 UTC.
  const at3 = new Date('2026-10-15T22:00:00Z');
  assert.deepEqual(boardNow(at3), { date: '2026-10-15', hour: 15 });
  assert.equal((await runLogisticsReminder(sql, { now: new Date('2026-10-15T23:00:00Z') })).sent, false, '4pm run does nothing');
  const first = await runLogisticsReminder(sql, { now: at3, boardUrl: 'https://board.test' });
  assert.equal(first.sent, true);
  const p = runs[0];
  assert.equal(p.action, 'logistics_reminder'); assert.equal(p.date, tomorrow); assert.equal(p.dayLabel, 'Fri, Oct 16');
  assert.equal(p.totalMoves, 3); assert.equal(p.readyMoves, 1); assert.equal(p.needsAttention, 2);
  assert.equal(p.missingDriverCount, 1); assert.equal(p.missingVehicleCount, 2); assert.equal(p.missingTimeCount, 1);
  assert.equal(p.summary, '2 of 3 moves for Fri, Oct 16 need attention: 1 no driver, 2 no vehicle, 1 no time.');
  assert.equal(p.movesText, '9:30 AM · Container Swap (30 Yard) · 2 Elm St · missing driver, vehicle\nNo time · Move · 3 Oak Ave · missing time, vehicle');
  assert.deepEqual(p.moves.map(m => m.moveId), ['b', 'c']);
  assert.equal(p.moves[0].jobId, 'opp2'); assert.equal(p.boardUrl, 'https://board.test'); assert.ok(p.eventId);
  assert.equal((await runLogisticsReminder(sql, { now: at3 })).reason, 'already sent today');
  assert.equal(runs.length, 1, 'once a day');
  assert.equal((await runLogisticsReminder(sql, { now: at3, force: true })).sent, true, 'Send now skips the guard');
  assert.equal(runs.length, 2); assert.equal(runs[1].forced, true);
  // Nothing missing: nothing sent.
  assert.equal(reminderFor([{ moveId: 'x', active: true, scheduledDate: tomorrow, scheduledTime: '07:00', driverName: 'Joe', assetId: 't1' }], tomorrow).needsAttention, 0);
  assert.equal((await runLogisticsReminder(sql, { now: new Date('2026-10-18T22:00:00Z'), force: true })).reason, 'everything for tomorrow is ready');
});

test('a vehicle on another open move needs allowShared (the board asks first)', async () => {
  const { saveState } = await import('../lib/store.mjs');
  await put('v1', { moveId: 'v1', active: true, status: 'scheduled', assets: [{ assetId: 'truck9', assetName: 'Truck 9' }] });
  await put('v2', { moveId: 'v2', active: true, status: 'scheduled' });
  await assert.rejects(saveState(sql, 'move', { moveId: 'v2', action: 'assign_asset', assetId: 'truck9', assetName: 'Truck 9', expectedVersion: 1, requestId: 'request-share-0001' }), /already assigned to another move/);
  const ok = await saveState(sql, 'move', { moveId: 'v2', action: 'assign_asset', assetId: 'truck9', assetName: 'Truck 9', allowShared: true, expectedVersion: 1, requestId: 'request-share-0002' });
  assert.deepEqual(ok.state.assets, [{ assetId: 'truck9', assetName: 'Truck 9', shared: true }]);
});
