// Field app schedule: a worker sees every job they are on for today and the next days
// (GET /api/driver-moves), including jobs 1 and 2 days out, and not other crews' jobs.
import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
process.env.DRIVER_TOKEN_SECRET = 'test-driver-secret'; process.env.SESSION_SECRET = 'test-secret';
const { signDriverToken } = await import('../lib/driver-token.mjs');
const { pacificDay } = await import('../lib/field-clock.mjs');
const { default: handler } = await import('../netlify/functions/driver-moves.mjs');
const sql = adapter(pg);
const day = n => { const d = new Date(pacificDay() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ana = signDriverToken({ driverKey: 'phone:5550000001', name: 'Ana Lopez', phone: '+15550000001' });
const get = async token => { const res = await handler(new Request('https://board.test/api/driver-moves', { headers: { authorization: 'Bearer ' + token } })); return { status: res.status, data: await res.json() }; };

test('field app worker sees own jobs today, 1 day out and 2 days out', async () => {
  await real.ensureSchema(sql);
  const me = [{ name: 'Ana Lopez', phone: '+15550000001' }], other = [{ name: 'Bo Diaz', phone: '+15550000002' }];
  const rows = [
    ['t0', day(0), me], ['t1', day(1), me], ['t2', day(2), me], ['t6', day(6), me],
    ['x2', day(2), other]
  ];
  for (const [id, date, crew] of rows) await sql`insert into job_shared_state (job_id, version, active, data) values (${id}, 1, true, ${JSON.stringify({ jobAddress: id + ' Main St', reportDate: date, reportTime: '07:00', reportEndDate: date, reportEndTime: '15:30', crew })})`;
  const r = await get(ana);
  assert.equal(r.status, 200);
  const ids = r.data.jobs.map(j => j.jobId).sort();
  assert.deepEqual(ids, ['t0', 't1', 't2', 't6'], 'own jobs for today through 6 days out, not another crew');
  const two = r.data.jobs.find(j => j.jobId === 't2');
  assert.equal(two.reportDate, day(2)); assert.equal(two.reportTime, '07:00'); assert.equal(two.jobAddress, 't2 Main St');
});
