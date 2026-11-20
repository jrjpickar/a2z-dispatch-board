// Text crew (job row dropdown): one crew member held 5 s, confirmed, texted now (Twilio only).
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
  { id: 't1', name: '10 Text St', sourceType: 'labor', contact: { name: 'T Co' }, customFields: [] },
  { id: 't2', name: '11 No Date Rd', sourceType: 'labor', contact: { name: 'T Co' }, customFields: [] }
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

test('setup', async () => {
  await real.ensureSchema(sql); await dd.ensureHoldTables(sql);
  await sql`insert into dispatch_feed_cache (key, data, updated_at) values ('ghl-jobs', ${JSON.stringify(jobsDb)}, now()) on conflict (key) do update set data = excluded.data`;
  await setState('t1', { jobAddress: '10 Text St', reportDate: FAR.date, reportTime: '07:00', reportEndDate: FAR.date, reportEndTime: '15:00',
    crew: [{ ...ANA, dontText: true }, { ...BO }] });
  await setState('t2', { jobAddress: '11 No Date Rd', crew: [{ ...ANA }] });
});

let reqN = 0;
async function queue(kind, payload) {
  const requestId = 'req-' + (++reqN);
  await sql`insert into dispatch_requests (request_id, fingerprint, result) values (${requestId}, 'f', ${JSON.stringify({ ok: true, record: { jobId: payload.jobId } })}) on conflict do nothing`;
  return (await post({ requestId, kind, payload, effectKey: 'k' + reqN })).json();
}
const textNow = w => post({ op: 'worker_text_now', jobId: 't1', worker: { contactId: w.id, workerName: w.name, workerPhone: w.phone } });

test('Text crew, Don\'t text worker: fresh rapid_assign to the worker webhook plus the text', async () => {
  stubFetch();
  const res = await textNow(ANA); const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data)); assert.equal(data.ok, true); assert.equal(data.makeOk, true); assert.equal(data.textOk, true);
  assert.equal(calls.texts.length, 1); assert.equal(calls.texts[0].to, ANA.phone); assert.match(calls.texts[0].body, /10 Text St/);
  assert.equal(calls.make.length, 1, 'one Make run');
  const run = calls.make[0];
  assert.equal(run.action, 'rapid_assign'); assert.equal(run.workerName, 'Ana Lopez'); assert.equal(run.workerPhone, ANA.phone); assert.equal(run.contactId, ANA.id);
  assert.equal(run.jobId, 't1'); assert.equal(run.reportDate, FAR.date); assert.equal(run.sentFrom, 'worker_text_now');
  const [n] = await sql`select count(*)::int as n from crew_notify where job_id = 't1' and worker_name = 'Ana Lopez' and notified = true`;
  assert.equal(n.n, 1, 'marked notified');
  const acts = await sql`select action from dispatch_activity`;
  assert.ok(acts.some(a => String(a.action).includes('Sent schedule text')), JSON.stringify(acts));
});

test('Text crew, waiting assign: that run goes to Make now (no second run later)', async () => {
  stubFetch();
  const q = await queue('workers', { action: 'assign', jobId: 't1', contactId: BO.id, workerName: BO.name, workerPhone: BO.phone, reportDate: FAR.date, reportTime: '07:00', textAtMode: 'default', textAt: '' });
  assert.equal(calls.make.length, 0, 'held until 12 hours before: ' + JSON.stringify(q));
  const data = await (await textNow(BO)).json();
  assert.equal(data.ok, true, JSON.stringify(data));
  assert.equal(calls.make.length, 1); assert.equal(calls.make[0].action, 'assign'); assert.equal(calls.make[0].workerName, 'Bo Diaz'); assert.equal(calls.make[0].textAtMode, 'now');
  assert.equal(calls.texts.length, 1); assert.equal(calls.texts[0].to, BO.phone);
  const [w] = await sql`select count(*)::int as n from dispatch_effects where status = 'nightly' and payload->>'jobId' = 't1'`;
  assert.equal(w.n, 0, 'nothing left waiting');
});

test('Text crew again: same worker gets the text and the Make run again (deliberate)', async () => {
  stubFetch();
  const data = await (await textNow(ANA)).json();
  assert.equal(data.ok, true); assert.equal(calls.texts.length, 1); assert.equal(calls.make.length, 1); assert.equal(calls.make[0].action, 'rapid_assign');
});

test('Remove as before: a worker sent with Text crew gets the remove run when taken off', async () => {
  stubFetch();
  await setState('t1', { jobAddress: '10 Text St', reportDate: FAR.date, reportTime: '07:00', reportEndDate: FAR.date, reportEndTime: '15:00', crew: [{ ...BO }] });
  await queue('workers', { action: 'remove', jobId: 't1', jobAddress: '10 Text St', removedWorkers: [{ contactId: ANA.id, workerName: ANA.name, workerPhone: ANA.phone }] });
  for (let i = 0; i < 20 && !calls.make.length; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(calls.make.length, 1, 'remove run sent'); assert.equal(calls.make[0].action, 'remove');
  assert.equal(calls.make[0].removedWorkers[0].workerName, 'Ana Lopez');
});

test('Text crew: refuses a worker not on the job and a job with no date', async () => {
  stubFetch();
  let res = await post({ op: 'worker_text_now', jobId: 't1', worker: { contactId: 'zz', workerName: 'Nobody Here', workerPhone: '+15550009999' } });
  assert.equal(res.status, 409); assert.match((await res.json()).error, /not on this job/);
  res = await post({ op: 'worker_text_now', jobId: 't2', worker: { contactId: ANA.id, workerName: ANA.name, workerPhone: ANA.phone } });
  assert.equal(res.status, 409); assert.match((await res.json()).error, /no date/);
  assert.equal(calls.texts.length, 0); assert.equal(calls.make.length, 0);
});
