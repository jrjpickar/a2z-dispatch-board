// Schedule texts that never went out while the board showed no problem:
//  1. A job whose date lives only in GHL (times never saved on the board): the server had no
//     date, so held runs waited forever and Send now dropped them ("Nothing new to send").
//  2. Crew carried to a new date: sent the job for the old date, nothing for the new one.
import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
Object.assign(process.env, { GHL_API_TOKEN: 'pit', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+19495550000',
  GHL_APP_CLIENT_ID: 'cid', GHL_APP_CLIENT_SECRET: 'secret', GHL_SMS_CONVERSATION_PROVIDER_ID: 'prov1', URL: 'https://board.test', SESSION_SECRET: 's3cret', CREW_TEXT_GHL_LOG: 'false' });
const dd = await import('../lib/daily-dispatch.mjs');
const timer = await import('../lib/hold-timer.mjs');
const { mutateJob } = await import('../lib/state.mjs');
const { textTracker } = await import('../lib/text-tracker.mjs');
const blob = new Map();
timer.setTimerStore({ get: async k => blob.has(k) ? JSON.parse(blob.get(k)) : null, setJSON: async (k, v) => { blob.set(k, JSON.stringify(v)); } });
const sql = adapter(pg);
const { default: effectHandler } = await import('../netlify/functions/workflow-effect.mjs');
const post = body => effectHandler(new Request('https://board.test/api/workflow-effect', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://board.test' }, body: JSON.stringify(body) }));

const at = ms => { const p = dd.pacificParts(ms); return { date: p.date, time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` }; };
const FAR = at(Date.now() + 3 * 864e5), NEAR = at(Date.now() + 6 * 3600e3);
const ANA = { id: 'ca', name: 'Ana Lopez', phone: '+15550000001' }, BO = { id: 'cb', name: 'Bo Diaz', phone: '+15550000002' }, CY = { id: 'cc', name: 'Cy Ruiz', phone: '+15550000003' };
// GHL jobs: the date is in the GHL custom field (what the board shows), not in the shared state.
const field = (date, time) => [{ id: 'rY3IebKlcBhAjWlaSSQm', fieldValueString: date }, { id: 'WtpFGtiB7hgmTGTsHJAW', fieldValueString: time }];
const jobsDb = [
  { id: 'g1', name: '1 Ghl St', sourceType: 'labor', contact: { name: 'G Co' }, customFields: field(FAR.date, '07:00') },
  { id: 'g2', name: '2 Ghl Ave', sourceType: 'labor', contact: { name: 'G Co' }, customFields: field(NEAR.date, NEAR.time) },
  { id: 'mv', name: '3 Moved Rd', sourceType: 'labor', contact: { name: 'M Co' }, customFields: [] }
];
let calls;
function stubFetch() {
  calls = { make: [], texts: [] };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('hook.us2.make.com')) { calls.make.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    if (url.includes('api.twilio.com')) { const b = new URLSearchParams(init.body); calls.texts.push({ to: b.get('To'), body: b.get('Body') }); return Response.json({ sid: 'SM' + Math.random() }, { status: 201 }); }
    if (url.includes('nightly-dispatch-background')) return new Response(null, { status: 202 });
    throw new Error('unexpected fetch ' + url);
  };
}
async function setState(jobId, data, active = true) {
  await sql`insert into job_shared_state (job_id, version, active, data) values (${jobId}, 1, ${active}, ${JSON.stringify(data)})
    on conflict (job_id) do update set data = excluded.data, active = excluded.active, version = job_shared_state.version + 1`;
}
let reqN = 0;
async function queue(kind, payload) {
  const requestId = 'req-' + (++reqN);
  await sql`insert into dispatch_requests (request_id, fingerprint, result) values (${requestId}, 'f', ${JSON.stringify({ ok: true, record: { jobId: payload.jobId } })}) on conflict do nothing`;
  return (await post({ requestId, kind, payload, effectKey: 'k' + reqN })).json();
}
// What the board posts on Assign selected: the times it shows (from GHL) ride along.
const assign = (jobId, w, d) => ({ action: 'assign', jobId, contactId: w.id, workerName: w.name, workerPhone: w.phone, reportDate: d.date, reportTime: d.time, reportEndDate: d.date, reportEndTime: '' });

test('setup', async () => {
  await real.ensureSchema(sql); await dd.ensureHoldTables(sql);
  await sql`insert into dispatch_feed_cache (key, data, updated_at) values ('ghl-jobs', ${JSON.stringify(jobsDb)}, now()) on conflict (key) do update set data = excluded.data`;
});

test('assign on a job with no saved times: the server state takes the times the board showed', () => {
  const next = mutateJob(null, { action: 'assign', jobId: 'x', reportDate: FAR.date, reportTime: '07:00', reportEndDate: FAR.date, reportEndTime: '15:00', nightWork: false, crewChanges: [{ name: 'Ana Lopez' }] });
  assert.deepEqual([next.data.reportDate, next.data.reportTime, next.data.reportEndTime], [FAR.date, '07:00', '15:00']);
  // Times already saved are never overwritten by an assign.
  const kept = mutateJob({ data: { reportDate: NEAR.date, reportTime: '06:00', crew: [] }, active: true }, { action: 'assign', reportDate: FAR.date, reportTime: '07:00', crewChanges: [{ name: 'Bo' }] });
  assert.deepEqual([kept.data.reportDate, kept.data.reportTime], [NEAR.date, '06:00']);
  // Unscheduled (reset cleared the times on purpose): an assign does not bring old times back.
  const reset = mutateJob({ data: { reportDate: '', reportTime: '', crew: [] }, active: true }, { action: 'assign', reportDate: FAR.date, reportTime: '07:00', crewChanges: [{ name: 'Bo' }] });
  assert.equal(reset.data.reportDate, '');
});

test('older record with no date (already in the database): Send now sends it, nothing is dropped', async () => {
  stubFetch();
  await setState('g1', { jobAddress: '1 Ghl St', crew: [ANA] }); // no reportDate key at all
  const r = await queue('workers', assign('g1', ANA, { date: FAR.date, time: '07:00' }));
  assert.equal(r.held, true);
  const sched = await dd.holdSchedule(sql);
  assert.equal(sched.find(j => j.jobId === 'g1').dueAt, dd.jobStartUtc(FAR.date, '07:00') - 12 * 3600e3, 'due time from the run the board sent');
  const res = await (await post({ op: 'job_send_now', jobId: 'g1' })).json();
  assert.equal(res.ok, true);
  assert.deepEqual([res.makeSent, res.texted], [1, 1]);
  assert.deepEqual(calls.texts.map(t => t.to), ['+15550000001']);
  assert.match(calls.texts[0].body, /1 Ghl St/);
});

test('older record with no date inside the 12 hours: goes out on assign', async () => {
  stubFetch();
  await setState('g2', { jobAddress: '2 Ghl Ave', crew: [BO] });
  const r = await queue('workers', assign('g2', BO, NEAR));
  assert.equal(r.held, false);
  assert.deepEqual([calls.make.length, calls.texts.map(t => t.to)], [1, ['+15550000002']]);
});

test('Send now on a job with no date anywhere: says so, keeps the waiting run', async () => {
  stubFetch();
  await setState('nd', { jobAddress: '9 No Date', crew: [CY] });
  await queue('workers', { action: 'assign', jobId: 'nd', contactId: CY.id, workerName: CY.name, workerPhone: CY.phone });
  const res = await (await post({ op: 'job_send_now', jobId: 'nd' })).json();
  assert.equal(res.ok, false); assert.equal(res.skipped, 'no_date'); assert.match(res.error, /no date/i);
  const [row] = await sql`select status from dispatch_effects where payload->>'jobId' = 'nd'`;
  assert.equal(row.status, 'nightly', 'the run still waits for a date');
});

test('crew carried to a new date: Send now sends the new date; the timer does too', async () => {
  stubFetch();
  // Sent the job for an earlier date, then the date moved and the crew stayed on.
  const old = dd.addDays(NEAR.date, -2);
  await setState('mv', { jobAddress: '3 Moved Rd', reportDate: NEAR.date, reportTime: NEAR.time, reportEndDate: NEAR.date, reportEndTime: '', crew: [ANA, BO] });
  for (const w of [ANA, BO]) await sql`insert into crew_notify (job_id, report_date, worker_key, worker_name, worker_phone, contact_id, notified, effect_id) values ('mv', ${old}, ${dd.workerKey(w)}, ${w.name}, ${w.phone}, ${w.id}, true, 'old')`;
  const owed = await dd.owedTexts(sql, { graceMs: 0 });
  assert.deepEqual(owed.filter(o => o.jobId === 'mv').map(o => [o.resend, o.workers.length]), [[true, 2]], 'the timer sees it as owed');
  const t = await textTracker(sql);
  const rows = t.jobs.find(j => j.jobId === 'mv').workers;
  assert.deepEqual(rows.map(w => w.status), ['overdue', 'overdue'], 'tracker shows it red, not "no text planned"');
  const out = await dd.runDue(sql, { gapMs: 10 });
  assert.ok(out.some(o => o.jobId === 'mv' && o.makeSent === 2 && o.texted === 2));
  assert.deepEqual(calls.make.map(m => [m.action, m.workerName, m.reportDate]), [['assign', 'Ana Lopez', NEAR.date], ['assign', 'Bo Diaz', NEAR.date]]);
  assert.equal(calls.texts.length, 2);
  const res = await (await post({ op: 'job_send_now', jobId: 'mv' })).json();
  assert.deepEqual([res.makeSent, res.texted], [0, 0], 'never twice');
});

test("Send now reports crew with no text planned instead of a bare 'nothing to send'", async () => {
  stubFetch();
  await setState('dt', { jobAddress: '4 Dont Txt', reportDate: FAR.date, reportTime: '08:00', reportEndDate: FAR.date, reportEndTime: '', crew: [CY] });
  const res = await (await post({ op: 'job_send_now', jobId: 'dt' })).json();
  assert.deepEqual([res.makeSent, res.texted, calls.texts.length], [0, 0, 0]);
  assert.deepEqual(res.notQueued, ['Cy Ruiz']);
});

test("times changed to a new day with Don't text: the timer leaves them alone", async () => {
  stubFetch();
  await setState('tm', { jobAddress: '5 Times', reportDate: NEAR.date, reportTime: NEAR.time, reportEndDate: NEAR.date, reportEndTime: '', crew: [ANA] });
  await sql`insert into crew_notify (job_id, report_date, worker_key, worker_name, worker_phone, contact_id, notified, effect_id) values ('tm', ${dd.addDays(NEAR.date, 1)}, ${dd.workerKey(ANA)}, ${ANA.name}, ${ANA.phone}, ${ANA.id}, true, 'old')`;
  await post({ op: 'times_changed', jobId: 'tm', resend: false, previous: { reportDate: dd.addDays(NEAR.date, 1), reportTime: '07:00' } });
  const owed = await dd.owedTexts(sql, { graceMs: 0 });
  assert.equal(owed.some(o => o.jobId === 'tm'), false);
});

test('problems board lists stuck crew sends and each text problem', async () => {
  const { crewProblems } = await import('../lib/text-tracker.mjs');
  await setState('st', { jobAddress: '6 Stuck', crew: [ANA] });
  await sql`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload, created_at) values ('st1', 'st1', 'workers', 'f', 'nightly', ${JSON.stringify({ action: 'assign', jobId: 'st', workerName: 'Ana Lopez', workerPhone: ANA.phone })}, now())`;
  // A run the old code dropped while the worker stayed on the crew (never sent).
  await setState('dr', { jobAddress: '7 Dropped', reportDate: FAR.date, reportTime: '07:00', crew: [BO] });
  await sql`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload, last_error) values ('dr1', 'dr1', 'workers', 'f', 'cancelled', ${JSON.stringify({ action: 'assign', jobId: 'dr', workerName: BO.name, workerPhone: BO.phone })}, 'Nothing to send: canceled out or replaced before it went out')`;
  const list = await crewProblems(sql);
  assert.ok(list.some(p => p.jobId === 'st' && p.type === 'no_date'), JSON.stringify(list));
  assert.ok(list.some(p => p.jobId === 'dr' && p.type === 'dropped' && p.workers[0] === 'Bo Diaz'), JSON.stringify(list));
});
