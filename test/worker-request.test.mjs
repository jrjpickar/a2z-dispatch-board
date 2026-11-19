import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
process.env.DRIVER_TOKEN_SECRET = 'test-driver-secret'; process.env.SESSION_SECRET = 'test-secret';
const { signDriverToken } = await import('../lib/driver-token.mjs');
const { cleanRequest, requestPayload, toolGroups } = await import('../lib/worker-request.mjs');
const { TOOL_GROUPS } = await import('../lib/job-log-doc.mjs');
const { default: handler } = await import('../netlify/functions/field-request.mjs');
const sql = adapter(pg);
const HOOK = 'hook.us2.make.com/zl49aboqhdloibnwwqegltw6z7mwpxtq';
const ana = signDriverToken({ driverKey: 'phone:5550000001', name: 'Ana Lopez', phone: '+15550000001' });
let runs, answer;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes(HOOK)) { runs.push(JSON.parse(init.body)); return answer(); }
  throw new Error('unexpected fetch ' + url);
};
const call = async (token, body, method = 'POST') => {
  const bg = [];
  const req = new Request('https://board.test/api/field-request', { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  const res = await handler(req, { waitUntil: p => bg.push(p) });
  await Promise.all(bg);
  return { status: res.status, data: await res.json() };
};

test('tool list is the job log list, in the same order', () => {
  assert.deepEqual(toolGroups().map(g => g.group), TOOL_GROUPS.map(g => g[0]));
  assert.deepEqual(toolGroups().flatMap(g => g.tools), TOOL_GROUPS.flatMap(g => g[1]));
});

test('cleanRequest keeps known tools only and needs text or a tool', () => {
  const r = cleanRequest({ message: '  need   bags \r\n now ', tools: ['Grinder', 'Grinder', 'Rocket launcher', 'Backhoe'], lang: 'es' });
  assert.deepEqual(r, { message: 'need bags \n now', tools: ['Grinder', 'Backhoe'], lang: 'es' });
  assert.throws(() => cleanRequest({ message: ' ', tools: ['Nope'] }), /Write what you need/);
  assert.throws(() => cleanRequest({ lang: 'es' }), /Escribe/);
  assert.equal(cleanRequest({ message: 'x'.repeat(5000) }).message.length, 1000);
});

test('payload groups tools and carries worker and job', () => {
  const p = requestPayload({ identity: { name: 'Ana Lopez', phone: '+15550000001' }, job: { jobId: 'j1', jobAddress: '1 Main', clientName: 'Kyle', reportDate: '2026-11-19' },
    request: { message: 'bags', tools: ['Grinder', 'Wheelbarrow', 'Generator'], lang: 'en' }, requestId: 'req-12345678', at: new Date('2026-11-19T18:05:00Z') });
  assert.equal(p.action, 'workerRequest'); assert.equal(p.workerName, 'Ana Lopez'); assert.equal(p.jobAddress, '1 Main');
  assert.equal(p.toolsText, 'Grinder, Wheelbarrow, Generator'); assert.equal(p.toolCount, 3);
  assert.equal(p.toolsByGroupText, 'Hand tools: Wheelbarrow\nPower tools: Grinder, Generator');
  assert.equal(p.date, '11/19/2026'); assert.equal(p.time, '10:05 AM'); assert.equal(p.dayOfWeek, 'thursday');
});

test('field request: sign in needed, GET serves the tool list', async () => {
  assert.equal((await call('', {}, 'GET')).status, 401);
  const r = await call(ana, null, 'GET');
  assert.equal(r.status, 200); assert.equal(r.data.toolGroups.length, TOOL_GROUPS.length);
});

test('field request: one Make run per request, job checked, replay sends once', async () => {
  runs = []; answer = () => new Response('Accepted');
  await real.ensureSchema(sql);
  await sql`insert into job_shared_state (job_id, version, active, data) values ('jr1', 1, true, ${JSON.stringify({ jobAddress: '267 E 16th St', clientName: 'Kyle Matt', reportDate: '2026-11-19', crew: [{ name: 'Ana Lopez', phone: '+15550000001' }] })})`;
  await sql`insert into job_shared_state (job_id, version, active, data) values ('jr2', 1, true, ${JSON.stringify({ jobAddress: 'Not hers', crew: [{ name: 'Bo Diaz', phone: '+15550000002' }] })})`;
  const ok = await call(ana, { requestId: 'req-aaaa1111', message: 'Need 2 boxes of bags', tools: ['Grinder', 'Fake'], jobId: 'jr1', lang: 'en' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].message, 'Need 2 boxes of bags'); assert.deepEqual(runs[0].tools, ['Grinder']);
  assert.equal(runs[0].jobAddress, '267 E 16th St'); assert.equal(runs[0].workerPhone, '+15550000001'); assert.ok(runs[0].eventId);
  const [row] = await sql`select status from dispatch_effects where kind = 'worker_request'`;
  assert.equal(row.status, 'confirmed'); // Make's plain "Accepted" counts
  const again = await call(ana, { requestId: 'req-aaaa1111', message: 'Need 2 boxes of bags', jobId: 'jr1' });
  assert.equal(again.data.replayed, true); assert.equal(runs.length, 1);
  assert.equal((await call(ana, { requestId: 'req-bbbb2222', message: 'x', jobId: 'jr2' })).status, 403);
  assert.equal((await call(ana, { requestId: 'req-cccc3333', message: '', tools: [] })).status, 400);
  assert.equal((await call(ana, { requestId: 'short', message: 'x' })).status, 428);
  const noJob = await call(ana, { requestId: 'req-dddd4444', tools: ['Backhoe'] });
  assert.equal(noJob.status, 200); assert.equal(runs.at(-1).jobId, ''); assert.equal(runs.at(-1).toolsText, 'Backhoe');
});

test('field request: a Make failure is kept for Retry', async () => {
  runs = []; answer = () => new Response('nope', { status: 500 });
  const r = await call(ana, { requestId: 'req-eeee5555', message: 'fail me' });
  assert.equal(r.status, 200);
  const [row] = await sql`select status from dispatch_effects where kind = 'worker_request' and payload->>'requestId' = 'req-eeee5555'`;
  assert.equal(row.status, 'uncertain');
});
