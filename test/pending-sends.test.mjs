// Crew runs waiting for their 12 hour mark ('nightly') and undo-window holds ('scheduled')
// are not Make problems: they stay out of Make / GHL problems, Acknowledge all, Retry and the
// run health chart, and show under Pending sends instead.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
process.env.SESSION_SECRET = 'pending-test-secret';
const sql = adapter(pg);
await real.ensureSchema(sql);
const { ensureHoldTables, pacificParts } = await import('../lib/daily-dispatch.mjs');
await ensureHoldTables(sql);
const { signSession } = await import('../lib/session.mjs');
const { default: senior } = await import('../netlify/functions/senior.mjs');
const { healthStats } = await import('../lib/dashboard-stats.mjs');
let makeCalls = 0;
globalThis.fetch = async () => { makeCalls++; return Response.json({ ok: true }); };

const token = signSession({ id: 'senior', name: 'Jesse Pickar', email: 'jesse@a2zcs.net' }, 'ghl_sso');
const get = view => senior(new Request('https://board.test/api/senior?view=' + view, { headers: { 'x-a2z-session': token } }));
const post = body => senior(new Request('https://board.test/api/senior', { method: 'POST', headers: { origin: 'https://board.test', 'content-type': 'application/json', 'x-a2z-session': token }, body: JSON.stringify(body) }));

const far = pacificParts(Date.now() + 3 * 864e5);
await sql`insert into job_shared_state (job_id, version, active, data) values ('job1', 1, true, ${JSON.stringify({ jobAddress: '17 Seabreeze, Dana Point', reportDate: far.date, reportTime: '07:00', crew: [{ name: 'Ana Lopez', phone: '+15550000001' }] })})`;
const assign = { action: 'assign', jobId: 'job1', jobName: '17 Seabreeze, Dana Point', workerName: 'Ana Lopez', workerPhone: '+15550000001' };
await sql`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload, created_at, updated_at)
  values ('wait1', 'r1', 'workers', 'f', 'nightly', ${JSON.stringify(assign)}, now() - interval '2 hours', now() - interval '2 hours'),
         ('hold1', 'r2', 'job_stage', 'f', 'scheduled', ${JSON.stringify({ action: 'complete', jobId: 'job1' })}, now() - interval '2 minutes', now() - interval '2 minutes'),
         ('bad1', 'r3', 'workers', 'f', 'uncertain', ${JSON.stringify({ ...assign, jobId: 'job2' })}, now() - interval '2 hours', now() - interval '2 hours')`;

test('waiting crew runs are not listed as Make problems', async () => {
  const data = await (await get('problems')).json();
  assert.deepEqual(data.effects.map(e => e.id), ['bad1']);
});

test('Pending sends lists the waiting run with its send time and worker', async () => {
  const res = await get('pending');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.jobs.length, 1);
  const job = data.jobs[0];
  assert.equal(job.name, '17 Seabreeze, Dana Point');
  assert.ok(job.dueAt && Date.parse(job.dueAt) > Date.now(), 'goes out later, 12 hours before the job');
  assert.equal(Date.parse(job.start) - Date.parse(job.dueAt), data.holdHours * 3600e3);
  assert.deepEqual(job.items.map(i => [i.id, i.label, i.workers]), [['wait1', 'Schedule text + worker notification', ['Ana Lopez']]]);
  assert.deepEqual(data.held.map(h => h.id), ['hold1']);
});

test('Retry and Acknowledge refuse a waiting run; Acknowledge all leaves it alone', async () => {
  assert.equal((await post({ action: 'retry_effect', effectId: 'wait1' })).status, 409);
  assert.equal((await post({ action: 'resolve_effect', effectId: 'wait1' })).status, 409);
  assert.equal((await post({ action: 'resolve_all' })).status, 200);
  const rows = Object.fromEntries((await sql`select effect_id, status from dispatch_effects`).map(r => [r.effect_id, r.status]));
  assert.deepEqual(rows, { wait1: 'nightly', hold1: 'scheduled', bad1: 'confirmed' });
  assert.equal(makeCalls, 0, 'nothing was sent early');
});

test('run health chart does not count waiting runs as needing attention', async () => {
  const stats = await healthStats(sql, pacificParts().date);
  const bad = stats.series.find(s => s.key === 'bad').values.reduce((a, b) => a + b, 0);
  assert.equal(bad, 1); // only bad1 (acknowledged by hand above)
});
