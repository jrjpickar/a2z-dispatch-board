import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureSchema } from '../netlify/functions/db.mjs';
import { saveState } from '../lib/store.mjs';
import { buildExport, dayFromJobLog } from '../lib/metrics-export.mjs';
import handler from '../netlify/functions/metrics-export.mjs';

const pg = new PGlite();
function adapter(engine) {
  const sql = async (strings, ...values) => (await engine.query(strings.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), values)).rows;
  sql.json = value => JSON.stringify(value);
  sql.begin = callback => engine.transaction(tx => callback(adapter(tx)));
  return sql;
}
const sql = adapter(pg);
await ensureSchema(sql);
const rid = () => crypto.randomUUID();

test('Complete EOD Sheet logs the day (times + crew) before the reset clears it', async () => {
  const c = await saveState(sql, 'job', { jobId: 'job-kpi', action: 'create', crew: 'Ana;Bob', reportDate: '2026-10-05', reportTime: '07:00', reportEndDate: '2026-10-05', reportEndTime: '15:00', jobType: 'hourly', expectedVersion: 0, requestId: rid() });
  const r = await saveState(sql, 'job', { jobId: 'job-kpi', action: 'reset_dispatch', expectedVersion: c.record.version, requestId: rid() });
  assert.equal(r.record.reportDate, '');
  assert.deepEqual(r.record.crew, []);
  const [row] = await sql`select * from job_day_log where job_id = 'job-kpi'`;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  assert.equal(row.report_date, '2026-10-05');
  assert.deepEqual(data.crew.map(w => w.name), ['Ana', 'Bob']);
  assert.equal(row.source, 'eod');
});

test('Completed on the same day keeps the crew already logged', async () => {
  const c = await saveState(sql, 'job', { jobId: 'job-kpi2', action: 'create', crew: 'Ana', reportDate: '2026-10-06', reportTime: '07:00', reportEndDate: '2026-10-06', reportEndTime: '15:00', expectedVersion: 0, requestId: rid() });
  const r = await saveState(sql, 'job', { jobId: 'job-kpi2', action: 'reset_dispatch', expectedVersion: 1, requestId: rid() });
  // Times re-entered without crew, then Completed: crew from the EOD log is kept.
  const t = await saveState(sql, 'job', { jobId: 'job-kpi2', action: 'save_times', reportDate: '2026-10-06', reportTime: '07:00', reportEndDate: '2026-10-06', reportEndTime: '16:00', expectedVersion: r.record.version, requestId: rid() });
  await saveState(sql, 'job', { jobId: 'job-kpi2', action: 'complete', expectedVersion: t.record.version, requestId: rid() });
  const rows = await sql`select * from job_day_log where job_id = 'job-kpi2'`;
  assert.equal(rows.length, 1);
  const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  assert.deepEqual(data.crew.map(w => w.name), ['Ana']);
  assert.equal(data.reportEndTime, '16:00');
  assert.equal(rows[0].source, 'complete');
});

test('closing a move keeps when it closed, its scheduled date, driver and vehicles', async () => {
  const c = await saveState(sql, 'move', { moveId: 'mv-kpi', action: 'create', movementType: 'container_drop', containerSize: '10 Yard', scheduledDate: '2026-10-07', scheduledTime: '08:00', driverName: 'Dee', assets: [{ assetId: 'T1', assetName: 'Truck 1' }], expectedVersion: 0, requestId: rid() });
  const done = await saveState(sql, 'move', { moveId: 'mv-kpi', action: 'complete', closedBy: 'Jesse', expectedVersion: c.state.version, requestId: rid() });
  assert.equal(done.state.status, 'completed');
  assert.equal(done.state.scheduledDate, '');
  assert.ok(done.state.completedAt);
  assert.deepEqual(done.state.closedSchedule, { date: '2026-10-07', time: '08:00' });
  assert.equal(done.state.closedDriverName, 'Dee');
  assert.deepEqual(done.state.closedAssetIds, ['T1']);
  assert.equal(done.state.closedBy, 'Jesse');
});

test('export includes logged days and backfills older days from job log payloads', async () => {
  await sql`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values ('e1', 'r1', 'job_log', 'f', 'confirmed', ${JSON.stringify({ jobId: 'job-old', reportDate: '2026-09-01', assignedWorkers: [{ contactId: 'c1', workerName: 'Cy' }] })})`;
  await sql`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values ('e2', 'r2', 'job_log', 'f', 'confirmed', ${JSON.stringify({ jobId: 'job-kpi', reportDate: '2026-10-05', assignedWorkers: [] })})`;
  await sql`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values ('e3', 'r3', 'eod_sheet', 'f', 'confirmed', ${JSON.stringify({ jobId: 'job-kpi', date: '2026-10-05', totalJobCost: '1,200', totalPriceToCustomer: '$1440' })})`;
  const out = await buildExport(sql);
  const old = out.jobDays.find(d => d.jobId === 'job-old');
  assert.equal(old.source, 'job_log_backfill');
  assert.equal(old.crew[0].name, 'Cy');
  const logged = out.jobDays.filter(d => d.jobId === 'job-kpi');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].crew.length, 2, 'log row wins over the backfill');
  assert.deepEqual([out.eodSheets[0].totalJobCost, out.eodSheets[0].totalPriceToCustomer], [1200, 1440]);
  assert.ok(out.moves.find(m => m.moveId === 'mv-kpi').completedAt);
});

test('dayFromJobLog ignores payloads without a job or date', () => {
  assert.equal(dayFromJobLog({ reportDate: '2026-10-01' }), null);
  assert.equal(dayFromJobLog('{"jobId":"x"}'), null);
});

test('feed is off without METRICS_EXPORT_KEY and refuses a wrong key', async () => {
  delete process.env.METRICS_EXPORT_KEY;
  assert.equal((await handler(new Request('https://x/api/metrics-export'))).status, 503);
  process.env.METRICS_EXPORT_KEY = 'k'.repeat(32);
  assert.equal((await handler(new Request('https://x/api/metrics-export', { headers: { 'x-metrics-key': 'nope' } }))).status, 401);
  delete process.env.METRICS_EXPORT_KEY;
});

test('a move Reset day logs the run; Unschedule does not', async () => {
  const c = await saveState(sql, 'move', { moveId: 'mv-run', action: 'create', movementType: 'container_drop', containerSize: '40 Yard', scheduledDate: '2026-10-08', scheduledTime: '09:00', driverName: 'Dee', sourceOpportunityId: 'opp-9', expectedVersion: 0, requestId: rid() });
  const r = await saveState(sql, 'move', { moveId: 'mv-run', action: 'reset_dispatch', expectedVersion: c.state.version, requestId: rid() });
  assert.equal(r.state.status, 'requested');
  const s = await saveState(sql, 'move', { moveId: 'mv-run', action: 'update_schedule', scheduledDate: '2026-10-09', scheduledTime: '09:00', expectedVersion: r.state.version, requestId: rid() });
  await saveState(sql, 'move', { moveId: 'mv-run', action: 'reset_dispatch', unscheduled: true, expectedVersion: s.state.version, requestId: rid() });
  const out = await buildExport(sql);
  const runs = out.moveRuns.filter(x => x.moveId === 'mv-run');
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].runDate, runs[0].movementType, runs[0].driverName, runs[0].sourceOpportunityId], ['2026-10-08', 'container_drop', 'Dee', 'opp-9']);
});
