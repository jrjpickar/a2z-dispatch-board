import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
process.env.DRIVER_TOKEN_SECRET = 'test-driver-secret'; process.env.SESSION_SECRET = 'test-secret';
delete process.env.GOOGLE_MAPS_API_KEY; // free lookups only
const { signDriverToken } = await import('../lib/driver-token.mjs');
const fc = await import('../lib/field-clock.mjs');
const { default: handler } = await import('../netlify/functions/field-clock.mjs');

const sql = adapter(pg);
const PIN = { lat: 33.64095, lng: -117.91462 };
const ana = signDriverToken({ driverKey: 'phone:5550000001', name: 'Ana Lopez', phone: '+15550000001' });
const bo = signDriverToken({ driverKey: 'phone:5550000002', name: 'Bo Diaz', phone: '+15550000002' });
let makeRuns, geocodes;
function stubFetch() {
  makeRuns = []; geocodes = 0;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('geocoding.geo.census.gov/geocoder/locations/onelineaddress')) { geocodes++; return Response.json({ result: { addressMatches: [{ coordinates: { x: PIN.lng, y: PIN.lat } }] } }); }
    if (url.includes('hook.us2.make.com/l4gm9c07tjmikwnv3xhwvf65a4irt3ql')) { makeRuns.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    throw new Error('unexpected fetch ' + url);
  };
}
const call = async (token, body, method = 'POST') => {
  let bg = [];
  const req = new Request('https://board.test/api/field-clock', { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  const res = await handler(req, { waitUntil: p => bg.push(p) });
  await Promise.all(bg);
  return { status: res.status, data: await res.json() };
};
const at = (ft, bearing = 45) => { // a reading `ft` feet from the pin
  const R = 20902231, d = ft / R, b = bearing * Math.PI / 180, la = PIN.lat * Math.PI / 180, lo = PIN.lng * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 * 180 / Math.PI, lng: lo2 * 180 / Math.PI, acc: 40 };
};
const SIG = 'data:image/png;base64,' + 'iVBORw0KGgo'.padEnd(800, 'A');
const SIGN = { breaks: 'certified', locationConsent: true, signature: SIG };
let n = 0; const rid = () => 'req' + Date.now().toString(36) + (++n).toString().padStart(4, '0');

test('Make formats: MM/DD/YY and 07:05AM Pacific, hours to two decimals', () => {
  assert.equal(fc.mdy('2026-11-03T15:05:00Z'), '11/03/26');
  assert.equal(fc.hhmmAmPm('2026-11-03T15:05:00Z'), '07:05AM');
  assert.equal(fc.hhmmAmPm('2026-11-03T23:31:00Z'), '03:31PM');
  assert.equal(fc.hoursBetween('2026-11-03T15:00:00Z', '2026-11-03T23:31:00Z'), 8.52);
  assert.equal(fc.jobIsToday({ reportDate: '2026-11-02', reportEndDate: '2026-11-03' }, '2026-11-03'), true);
  assert.equal(fc.jobIsToday({ reportDate: '2026-11-04' }, '2026-11-03'), false);
});

test('clock in needs location, the crew and today; saves distance and posts clockIn with jobId', async () => {
  await real.ensureSchema(sql);
  const today = fc.pacificDay();
  await sql`insert into job_shared_state (job_id, version, active, data) values ('j1', 1, true, ${JSON.stringify({ jobAddress: '267 E 16th St, Costa Mesa, CA 92627', clientName: 'Kyle Matt', scopeOfWork: 'Kitchen demo', reportDate: today, reportTime: '07:00', crew: [{ name: 'Ana Lopez', phone: '+15550000001' }] })})`;
  await sql`insert into job_shared_state (job_id, version, active, data) values ('j2', 1, true, ${JSON.stringify({ jobAddress: '9 Later St', reportDate: '2099-01-01', crew: [{ name: 'Ana Lopez', phone: '+15550000001' }] })})`;
  stubFetch();
  let r = await call(ana, { op: 'clockIn', jobId: 'j1', requestId: rid() });
  assert.equal(r.status, 400); assert.match(r.data.error, /Location is required/);
  r = await call(ana, { op: 'clockIn', jobId: 'j1', requestId: rid(), location: { ...at(100), acc: 3000 } });
  assert.equal(r.status, 422); assert.match(r.data.error, /too rough/);
  r = await call(bo, { op: 'clockIn', jobId: 'j1', requestId: rid(), location: at(100) });
  assert.equal(r.status, 403, 'not on the crew');
  r = await call(ana, { op: 'clockIn', jobId: 'j2', requestId: rid(), location: at(100) });
  assert.equal(r.status, 409, 'not today');
  assert.equal(makeRuns.length, 0);
  const id = rid();
  r = await call(ana, { op: 'clockIn', jobId: 'j1', requestId: id, location: at(120) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.clockIn.status, 'unknown', 'first punch on a job: the answer does not wait on the address lookup');
  assert.equal(r.data.open.jobId, 'j1');
  assert.equal(makeRuns.length, 1);
  const run = makeRuns[0];
  assert.equal(run.action, 'clockIn'); assert.equal(run.jobId, 'j1'); assert.equal(run.hoursWorked, 0);
  assert.equal(run.scopeOfWork, ''); assert.equal(run.notes, '');
  assert.match(run.date, /^\d{2}\/\d{2}\/\d{2}$/); assert.match(run.time, /^\d{2}:\d{2}(AM|PM)$/);
  assert.ok(Math.abs(run.distanceFt - 120) < 3, 'the lookup ran right after and the Make run has the distance');
  const [saved] = await sql`select clock_in from field_shifts where id = ${'shift-' + id}`;
  assert.equal((typeof saved.clock_in === 'string' ? JSON.parse(saved.clock_in) : saved.clock_in).status, 'onsite', 'the saved punch got its distance');
  assert.equal(run.workerName, 'Ana Lopez'); assert.equal(run.employeeName, 'Ana Lopez'); assert.equal(run.locationStatus, 'onsite'); assert.equal(run.jobScopeOfWork, 'Kitchen demo'); assert.ok(run.eventId);
  // Same request again (double tap / retry): no second shift, no second run.
  r = await call(ana, { op: 'clockIn', jobId: 'j1', requestId: id, location: at(120) });
  assert.equal(r.data.replayed, true); assert.equal(makeRuns.length, 1);
  r = await call(ana, { op: 'clockIn', jobId: 'j1', requestId: rid(), location: at(120) });
  assert.equal(r.status, 409, 'already clocked in');
  assert.equal(geocodes, 1, 'job address looked up once');
});

test('live pings update the open shift, spaced out; no Make run', async () => {
  stubFetch();
  await sql`update field_shifts set last_loc = jsonb_set(last_loc, '{at}', to_jsonb((now() - interval '10 minutes')::text)) where clock_out is null`;
  let r = await call(ana, { op: 'ping', location: at(2.4 * 5280, 290) });
  assert.equal(r.status, 200); assert.ok(r.data.lastAt);
  r = await call(ana, { op: 'ping', location: at(100) });
  assert.equal(r.data.skipped, true, 'too soon after the last one');
  const [row] = await sql`select last_loc, trail from field_shifts where clock_out is null`;
  const last = typeof row.last_loc === 'string' ? JSON.parse(row.last_loc) : row.last_loc;
  assert.equal(last.status, 'away');
  assert.equal((typeof row.trail === 'string' ? JSON.parse(row.trail) : row.trail).length, 2);
  assert.equal(makeRuns.length, 0);
});

test('clock out needs a work summary and location; posts clockOut with hours, scopeOfWork, notes, jobId', async () => {
  stubFetch();
  await sql`update field_shifts set clock_in = jsonb_set(clock_in, '{at}', to_jsonb((now() - interval '8 hours 30 minutes')::text)) where clock_out is null`;
  let r = await call(ana, { op: 'clockOut', requestId: rid(), location: at(80), work: '' });
  assert.equal(r.status, 400); assert.match(r.data.error, /work done/);
  r = await call(ana, { op: 'clockOut', requestId: rid(), work: 'Demo, Cleanup', ...SIGN });
  assert.equal(r.status, 400); assert.match(r.data.error, /Location is required/);
  r = await call(ana, { op: 'clockOut', requestId: rid(), location: at(80), work: 'Demo', ...SIGN, breaks: undefined });
  assert.equal(r.status, 400); assert.match(r.data.error, /breaks/);
  r = await call(ana, { op: 'clockOut', requestId: rid(), location: at(80), work: 'Demo', ...SIGN, locationConsent: false });
  assert.equal(r.status, 400); assert.match(r.data.error, /location consent/);
  r = await call(ana, { op: 'clockOut', requestId: rid(), location: at(80), work: 'Demo', ...SIGN, signature: '' });
  assert.equal(r.status, 400); assert.match(r.data.error, /Sign with your finger/);
  r = await call(ana, { op: 'clockOut', requestId: rid(), location: at(80), work: 'Demo', ...SIGN, signature: 'data:image/png;base64,' + 'A'.repeat(95000) });
  assert.equal(r.status, 400); assert.match(r.data.error, /too big/);
  assert.equal(makeRuns.length, 0, 'nothing sent for refused clock outs');
  const id = rid();
  r = await call(ana, { op: 'clockOut', requestId: id, location: at(80), work: 'Demo, Cleanup', notes: 'Need a dumpster swap', lang: 'es', ...SIGN });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.open, null); assert.equal(r.data.hoursWorked, 8.5);
  assert.equal(makeRuns.length, 1);
  const run = makeRuns[0];
  assert.equal(run.action, 'clockOut'); assert.equal(run.jobId, 'j1'); assert.equal(run.hoursWorked, 8.5);
  assert.equal(run.scopeOfWork, 'Demo, Cleanup'); assert.equal(run.notes, 'Need a dumpster swap'); assert.equal(run.language, 'es');
  assert.equal(run.breaksCertified, true); assert.equal(run.locationConsent, true); assert.match(run.certification, /^By signing I hereby certify/);
  assert.equal(run.signedBy, 'Ana Lopez'); assert.ok(run.signedAt); assert.equal(run.signature, SIG.split(',')[1], 'signature as base64 PNG');
  assert.match(run.date, /^\d{2}\/\d{2}\/\d{2}$/); assert.match(run.time, /^\d{2}:\d{2}(AM|PM)$/); assert.match(run.clockInTime, /^\d{2}:\d{2}(AM|PM)$/);
  r = await call(ana, { op: 'clockOut', requestId: id, location: at(80), work: 'Demo, Cleanup' });
  assert.equal(r.data.replayed, true); assert.equal(makeRuns.length, 1, 'no second run on retry');
  r = await call(ana, { op: 'clockOut', requestId: rid(), location: at(80), work: 'x y z' });
  assert.equal(r.status, 409, 'not clocked in anymore');
  r = await call(ana, null, 'GET');
  assert.equal(r.data.open, null); assert.equal(r.data.recent[0].summary.work, 'Demo, Cleanup');
});

test('free job lookup: Census first, OpenStreetMap when Census has no match, retry later when both are down', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    url = String(url); calls.push(new URL(url).hostname);
    if (url.includes('census.gov')) return Response.json({ result: { addressMatches: [] } });
    if (url.includes('nominatim.openstreetmap.org')) return Response.json([{ lat: '33.6', lon: '-117.9' }]);
    throw new Error('unexpected ' + url);
  };
  assert.deepEqual(await fc.geocode('1 Main St, Costa Mesa, CA'), { pin: { lat: 33.6, lng: -117.9 }, source: 'osm' });
  assert.deepEqual(calls, ['geocoding.geo.census.gov', 'nominatim.openstreetmap.org'], 'no Google call without a key');
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.deepEqual(await fc.geocode('1 Main St'), { pin: null, retry: true });
  globalThis.fetch = async url => String(url).includes('census') ? Response.json({ result: { addressMatches: [] } }) : Response.json([]);
  assert.deepEqual(await fc.geocode('Nowhere'), { pin: null, retry: false });
});

test('clock webhook: a plain "Accepted" from Make counts as sent (no Webhook response needed)', async () => {
  const { sendWorkflow } = await import('../lib/effects.mjs');
  globalThis.fetch = async () => new Response('Accepted', { status: 200 });
  await sendWorkflow('clock', { action: 'clockIn', jobId: 'j1' }, 'e1');
  await assert.rejects(sendWorkflow('worker_sent_home', { action: 'worker_sent_home', jobId: 'j1' }, 'e2'), /Accepted/, 'other webhooks still need the response');
});

test('no sign-in, no clock (field app)', async () => {
  const res = await handler(new Request('https://board.test/api/field-clock'), {});
  assert.equal(res.status, 401);
});

test('board Time Clock: signed-in board users read the day with locations, trail and summary', async () => {
  const { signSession } = await import('../lib/session.mjs');
  const { default: board } = await import('../netlify/functions/time-clock.mjs');
  let res = await board(new Request('https://board.test/api/time-clock'));
  assert.equal(res.status, 401, 'board sign-in required');
  const session = signSession({ id: 'uJessePickar01', name: 'Jesse Pickar', email: 'jesse@a2zcs.net' }, 'ghl_sso');
  res = await board(new Request('https://board.test/api/time-clock?day=' + fc.pacificDay(), { headers: { 'x-a2z-session': session } }));
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.shifts.length, 1);
  const s = data.shifts[0];
  assert.equal(s.jobId, 'j1'); assert.equal(s.workerName, 'Ana Lopez');
  assert.ok(s.clockIn.lat && s.clockOut.lat); assert.equal(s.summary.work, 'Demo, Cleanup');
  assert.ok(s.trail.length >= 3); assert.deepEqual(data.pins.j1, PIN);
  assert.equal(s.summary.breaksCertified, true); assert.equal(s.summary.locationConsent, true); assert.equal(s.summary.hasSignature, true);
  const img = await board(new Request('https://board.test/api/time-clock?signature=' + s.id, { headers: { 'x-a2z-session': session } }));
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await board(new Request('https://board.test/api/time-clock?signature=' + s.id))).status, 401, 'signature needs board sign-in');
  res = await board(new Request('https://board.test/api/time-clock?day=2001-01-01', { headers: { 'x-a2z-session': session } }));
  assert.equal((await res.json()).shifts.length, 0);
});

test('forgotten clock out: after 16 hours the next clock in closes it (flagged) and goes ahead', async () => {
  stubFetch();
  const id1 = rid();
  let r = await call(ana, { op: 'clockIn', jobId: 'j1', requestId: id1, location: at(100) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call(ana, { op: 'clockIn', jobId: 'j1', requestId: rid(), location: at(100) });
  assert.equal(r.status, 409, 'still on the clock: no second clock in yet');
  await sql`update field_shifts set clock_in = jsonb_set(clock_in, '{at}', to_jsonb((now() - interval '17 hours')::text)), last_loc = jsonb_set(last_loc, '{at}', to_jsonb((now() - interval '9 hours')::text)) where id = ${'shift-' + id1}`;
  makeRuns = [];
  r = await call(ana, { op: 'clockIn', jobId: 'j1', requestId: rid(), location: at(100) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const out = makeRuns.find(m => m.action === 'clockOut');
  assert.ok(out, 'the forgotten shift got its clockOut run'); assert.equal(out.autoClosed, true); assert.equal(out.hoursWorked, 8);
  assert.ok(makeRuns.find(m => m.action === 'clockIn'), 'and the new clock in went through');
  // Clock back out so later tests start clean.
  r = await call(ana, { op: 'clockOut', requestId: rid(), location: at(100), work: 'Demo', ...SIGN, breaks: 'missed' });
  assert.equal(r.status, 400, 'the breaks statement is the only choice'); assert.match(r.data.error, /breaks statement/);
  r = await call(ana, { op: 'clockOut', requestId: rid(), location: at(100), work: 'Demo', ...SIGN });
  assert.equal(r.status, 200);
});
