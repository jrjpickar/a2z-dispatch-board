// Crew hold: assign / remove runs and the schedule text wait until 12 hours before the job.
import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
Object.assign(process.env, { GHL_API_TOKEN: 'pit', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+19495550000',
  GHL_APP_CLIENT_ID: 'cid', GHL_APP_CLIENT_SECRET: 'secret', GHL_SMS_CONVERSATION_PROVIDER_ID: 'prov1', URL: 'https://board.test', SESSION_SECRET: 's3cret' });
const dd = await import('../lib/daily-dispatch.mjs');
const timer = await import('../lib/hold-timer.mjs');
const blob = new Map();
timer.setTimerStore({ get: async k => blob.has(k) ? JSON.parse(blob.get(k)) : null, setJSON: async (k, v) => { blob.set(k, JSON.stringify(v)); } });
const sql = adapter(pg);
const { default: effectHandler } = await import('../netlify/functions/workflow-effect.mjs');
const post = body => effectHandler(new Request('https://board.test/api/workflow-effect', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://board.test' }, body: JSON.stringify(body) }));

// Dates relative to now (Pacific): FAR starts in 3 days, NEAR in 6 hours.
const at = ms => { const p = dd.pacificParts(ms); return { date: p.date, time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` }; };
const FAR = at(Date.now() + 3 * 864e5), NEAR = at(Date.now() + 6 * 3600e3), NEAR2 = at(Date.now() + 8 * 3600e3);
const ANA = { id: 'ca', name: 'Ana Lopez', phone: '+15550000001' }, BO = { id: 'cb', name: 'Bo Diaz', phone: '+15550000002' }, CY = { id: 'cc', name: 'Cy Ruiz', phone: '+15550000003' }, DE = { id: 'cd', name: 'De Paz', phone: '+15550000004' }, ED = { id: 'ce', name: 'Ed Mo', phone: '+15550000005' };
const jobsDb = [
  { id: 'far', name: '1 Far St', sourceType: 'labor', contact: { name: 'Far Co' }, customFields: [] },
  { id: 'near', name: '2 Near Ave', sourceType: 'labor', contact: { name: 'Near Co' }, customFields: [] },
  { id: 'gone', name: '3 Gone Rd', sourceType: 'labor', contact: { name: 'Gone Co' }, customFields: [] },
  { id: 'late', name: '4 Late Ln', sourceType: 'labor', contact: { name: 'Late Co' }, customFields: [] }
];
let calls;
function stubFetch() {
  calls = { make: [], texts: [], runner: [] };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('hook.us2.make.com')) { const b = JSON.parse(init.body); calls.make.push({ hook: url.includes('dk8dm') ? 'workers' : url.includes('s2ijm') ? 'job_stage' : url.includes('pnoqc') ? 'split' : url, ...b }); return Response.json({ ok: true }); }
    if (url.includes('api.twilio.com')) { const b = new URLSearchParams(init.body); calls.texts.push({ to: b.get('To'), body: b.get('Body') }); return Response.json({ sid: 'SM' + Math.random() }, { status: 201 }); }
    if (url.includes('nightly-dispatch-background')) { calls.runner.push(JSON.parse(init.body).due); return new Response(null, { status: 202 }); }
    if (url.includes('/conversations/search?')) return Response.json({ conversations: [{ id: 'conv' }] });
    if (url.includes('/contacts/search/duplicate')) return Response.json({ contact: { id: 'cx' } });
    if (url.endsWith('/conversations/messages/inbound')) return Response.json({ messageId: 'm' });
    throw new Error('unexpected fetch ' + url);
  };
}
async function setState(jobId, data, active = true) {
  await sql`insert into job_shared_state (job_id, version, active, data) values (${jobId}, 1, ${active}, ${JSON.stringify(data)})
    on conflict (job_id) do update set data = excluded.data, active = excluded.active, version = job_shared_state.version + 1`;
}
const crewOf = async jobId => (d => typeof d === 'string' ? JSON.parse(d) : d)((await sql`select data from job_shared_state where job_id = ${jobId}`)[0].data).crew || [];
async function setCrew(jobId, crew) { const [r] = await sql`select data, active from job_shared_state where job_id = ${jobId}`; await setState(jobId, { ...(typeof r.data === 'string' ? JSON.parse(r.data) : r.data), crew }, r.active); }
let reqN = 0;
async function queue(kind, payload, { requestId, effectKey } = {}) {
  requestId ||= 'req-' + (++reqN);
  await sql`insert into dispatch_requests (request_id, fingerprint, result) values (${requestId}, 'f', ${JSON.stringify({ ok: true, record: { jobId: payload.jobId } })}) on conflict do nothing`;
  const res = await post({ requestId, kind, payload, effectKey: effectKey || 'k' + reqN });
  return res.json();
}
const assign = (jobId, w, extra = {}) => ({ action: 'assign', jobId, contactId: w.id, workerName: w.name, workerPhone: w.phone, ...extra });
const remove = (jobId, ...ws) => ({ action: 'remove', jobId, removedWorkers: ws.map(w => ({ contactId: w.id, workerName: w.name, workerPhone: w.phone })) });
// What the board does: save the crew, then post the run.
async function boardAssign(jobId, w, extra) { await setCrew(jobId, [...(await crewOf(jobId)), w]); return queue('workers', assign(jobId, w, extra)); }
async function boardRemove(jobId, w) { await setCrew(jobId, (await crewOf(jobId)).filter(c => c.phone !== w.phone)); return queue('workers', remove(jobId, w)); }
const states = async () => Object.fromEntries((await sql`select effect_id, status from dispatch_effects`).map(r => [r.effect_id, r.status]));

test('setup', async () => {
  await real.ensureSchema(sql); await dd.ensureHoldTables(sql);
  await sql`insert into dispatch_feed_cache (key, data, updated_at) values ('ghl-jobs', ${JSON.stringify(jobsDb)}, now()) on conflict (key) do update set data = excluded.data`;
  await sql`insert into dispatch_settings (key, value) values ('ghl-oauth:QUcu2PEAxPV1sQm1GQCq', ${JSON.stringify({ access_token: 'at', refresh_token: 'rt', expiresAt: Date.now() + 3600e3, locationId: 'QUcu2PEAxPV1sQm1GQCq' })}) on conflict (key) do nothing`;
  await setState('far', { jobAddress: '1 Far St', reportDate: FAR.date, reportTime: '07:00', reportEndDate: FAR.date, reportEndTime: '15:30', crew: [] });
  await setState('near', { jobAddress: '2 Near Ave', reportDate: NEAR.date, reportTime: NEAR.time, reportEndDate: NEAR.date, reportEndTime: '', crew: [] });
  await setState('gone', { jobAddress: '3 Gone Rd', reportDate: FAR.date, reportTime: '08:00', reportEndDate: FAR.date, reportEndTime: '', crew: [] });
  await setState('late', { jobAddress: '4 Late Ln', reportDate: NEAR2.date, reportTime: NEAR2.time, reportEndDate: NEAR2.date, reportEndTime: '', crew: [] });
});

test('normal assign more than 12 hours out: nothing goes to Make and nobody is texted yet', async () => {
  stubFetch();
  let r = await boardAssign('far', ANA); assert.equal(r.ok, true); assert.equal(r.held, true);
  r = await boardAssign('far', BO); assert.equal(r.held, true);
  assert.deepEqual([calls.make.length, calls.texts.length], [0, 0]);
  const w = await (await effectHandler(new Request('https://board.test/api/workflow-effect?waiting=jobs'))).json();
  assert.deepEqual(w.jobs.far.names, ['Ana Lopez', 'Bo Diaz']);
  assert.equal(Date.parse(w.jobs.far.dueAt), dd.jobStartUtc(FAR.date, '07:00') - 12 * 3600e3, 'goes out 12 hours before the start');
  assert.equal(JSON.parse(blob.get('next')).nextDue, dd.jobStartUtc(FAR.date, '07:00') - 12 * 3600e3, 'timer knows the next due time');
});

test('worker moved before the 12 hours: only the new job is sent, no remove run', async () => {
  stubFetch();
  let r = await boardRemove('far', BO);
  assert.equal(calls.make.length, 0, 'Bo was never notified: no remove run');
  r = await boardAssign('near', BO); // near starts in 6 hours: inside the 12 hours, goes now
  assert.equal(r.held, false);
  assert.deepEqual(calls.make.map(m => [m.hook, m.action, m.jobId, m.workerName]), [['workers', 'assign', 'near', 'Bo Diaz']]);
  assert.deepEqual(calls.texts.map(t => t.to), ['+15550000002']);
  assert.ok(calls.texts[0].body.includes('2 Near Ave') && !calls.texts[0].body.includes('1 Far St'), 'text has the new job only');
});

test('worker moved after the 12 hours: remove run on the old job, assign + new text on the new job, right away', async () => {
  stubFetch();
  await boardRemove('near', BO);
  await boardAssign('late', BO); // late starts in 8 hours
  assert.deepEqual(calls.make.map(m => [m.action, m.jobId]), [['remove', 'near'], ['assign', 'late']]);
  assert.deepEqual(calls.make[0].removedWorkers.map(w => w.workerName), ['Bo Diaz']);
  assert.deepEqual(calls.texts.map(t => t.to), ['+15550000002']);
  assert.ok(calls.texts[0].body.includes('4 Late Ln'));
});

test('put back on a job he was removed from: texted again, once', async () => {
  stubFetch();
  await boardRemove('late', BO);
  await boardAssign('near', BO);
  assert.deepEqual(calls.make.map(m => [m.action, m.jobId]), [['remove', 'late'], ['assign', 'near']]);
  assert.deepEqual(calls.texts.map(t => t.to), ['+15550000002'], 'his earlier near text was cleared by the remove, so he gets the current one');
});

test('Send schedule now: right away, never twice; removing that worker later sends the remove now', async () => {
  stubFetch();
  await setCrew('far', [...(await crewOf('far')), CY]);
  let r = await queue('workers', { ...assign('far', CY), action: 'rapid_assign', rapidAssign: true, reportDate: FAR.date });
  assert.equal(r.ok, true);
  r = await queue('workers', { ...assign('far', CY), action: 'rapid_assign', rapidAssign: true, reportDate: FAR.date });
  assert.equal(r.duplicate, true, 'second Send schedule now for the same worker and job is not sent');
  assert.deepEqual(calls.make.map(m => m.action), ['rapid_assign']);
  await boardRemove('far', CY);
  assert.deepEqual(calls.make.map(m => m.action), ['rapid_assign', 'remove'], 'notified by Send schedule now, so the remove goes right away');
});

test('replaying the same request never sends twice', async () => {
  stubFetch();
  await setCrew('near', [...(await crewOf('near')), DE]);
  const a = await queue('workers', assign('near', DE), { requestId: 'same-1', effectKey: 'de' });
  const b = await queue('workers', assign('near', DE), { requestId: 'same-1', effectKey: 'de' });
  assert.equal(a.ok, true); assert.equal(b.replayed, true);
  assert.equal(calls.make.filter(m => m.workerName === 'De Paz').length, 1);
  assert.equal(calls.texts.filter(t => t.to === '+15550000004').length, 1);
});

test('Send now twice at the same moment: each worker gets one run and one text', async () => {
  stubFetch();
  await setCrew('gone', [ED]);
  await queue('workers', assign('gone', ED));
  assert.equal(calls.make.length, 0);
  const [x, y] = await Promise.all([post({ op: 'job_send_now', jobId: 'gone' }), post({ op: 'job_send_now', jobId: 'gone' })].map(p => p.then(r => r.json())));
  assert.equal(x.makeSent + y.makeSent, 1);
  assert.equal(calls.make.length, 1); assert.equal(calls.texts.length, 1);
});

test('12 hour mark: the job goes out as it sits (Ana only; Bo moved, Cy removed), texted once', async () => {
  stubFetch();
  const due = dd.jobStartUtc(FAR.date, '07:00') - 12 * 3600e3;
  const out = await dd.runDue(sql, { now: () => due + 1000, gapMs: 10 });
  assert.deepEqual(out.map(o => o.jobId), ['far']);
  assert.deepEqual(calls.make.map(m => [m.action, m.workerName]), [['assign', 'Ana Lopez']]);
  assert.deepEqual(calls.texts.map(t => t.to), ['+15550000001']);
  const again = await dd.runDue(sql, { now: () => due + 5000, gapMs: 10 });
  assert.deepEqual(again, [], 'nothing left waiting');
  const res = await (await post({ op: 'job_send_now', jobId: 'far' })).json();
  assert.deepEqual([res.makeSent, res.texted], [0, 0], 'Send now afterwards sends nothing twice');
  assert.equal(calls.make.length, 1);
});

test("Don't text: a worker on the crew with no run is never sent or texted", async () => {
  stubFetch();
  await setCrew('far', [...(await crewOf('far')), DE]); // assigned with Don't text: no run posted
  const res = await (await post({ op: 'job_send_now', jobId: 'far' })).json();
  assert.deepEqual([res.makeSent, res.texted, calls.texts.length], [0, 0, 0]);
});

test('job cancelled before the 12 hours: only the cancel webhook, crew not told, everything wiped', async () => {
  stubFetch();
  await setState('cx', { jobAddress: '9 Cancel Ct', reportDate: FAR.date, reportTime: '09:00', crew: [] });
  await boardAssign('cx', ANA); await boardAssign('cx', BO);
  assert.equal(calls.make.length, 0);
  await setState('cx', { jobAddress: '9 Cancel Ct', reportDate: FAR.date, reportTime: '09:00', crew: [], status: 'cancelled' }, false);
  const r = await queue('job_stage', { action: 'cancel', jobId: 'cx', opportunityId: 'cx' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.make.map(m => [m.hook, m.action]), [['job_stage', 'cancel']], 's2ijm only, dk8dm not hit');
  assert.equal(calls.texts.length, 0);
  const waiting = (await sql`select count(*)::int as n from dispatch_effects where status = 'nightly' and payload->>'jobId' = 'cx'`)[0].n;
  assert.equal(waiting, 0);
  assert.equal((await sql`select count(*)::int as n from crew_notify where job_id = 'cx'`)[0].n, 0);
});

test('job cancelled after the crew was notified: notified workers get their remove run, then the cancel', async () => {
  stubFetch();
  await setState('cy', { jobAddress: '8 Late Cancel', reportDate: NEAR.date, reportTime: NEAR.time, crew: [] });
  await boardAssign('cy', ED); // inside 12 hours: notified now
  await setCrew('cy', [...(await crewOf('cy')), CY]); // Cy added with Don't text: never notified
  calls.make = [];
  await setState('cy', { jobAddress: '8 Late Cancel', reportDate: NEAR.date, reportTime: NEAR.time, crew: [], status: 'cancelled' }, false);
  await queue('job_stage', { action: 'cancel', jobId: 'cy', opportunityId: 'cy' });
  assert.deepEqual(calls.make.map(m => [m.hook, m.action, (m.removedWorkers || []).map(w => w.workerName).join()]), [['workers', 'remove', 'Ed Mo'], ['job_stage', 'cancel', '']]);
});

test('timer: the 5 minute check reads the blob only and starts one runner when due', async () => {
  stubFetch();
  let dbUsed = 0;
  const getSql = async () => { dbUsed++; return sql; };
  const now = Date.now();
  blob.set('next', JSON.stringify({ nextDue: now + 20 * 60e3, runnerFor: null, checkedAt: now }));
  await timer.cronTick({ now, getSql });
  assert.deepEqual([dbUsed, calls.runner.length], [0, 0], 'not due yet: no database, no runner');
  blob.set('next', JSON.stringify({ nextDue: now + 3 * 60e3, runnerFor: null, checkedAt: now }));
  await timer.cronTick({ now, getSql }); await timer.cronTick({ now, getSql });
  assert.deepEqual([dbUsed, calls.runner], [0, [now + 3 * 60e3]], 'one runner for that due time');
  blob.set('next', JSON.stringify({ nextDue: null, runnerFor: null, checkedAt: now - 7 * 3600e3 }));
  await timer.cronTick({ now, getSql });
  assert.equal(dbUsed, 1, 'old blob: one database check');
});

test('runner rejects a wrong key', async () => {
  const { default: runner } = await import('../netlify/functions/nightly-dispatch-background.mjs');
  const res = await runner(new Request('https://board.test/.netlify/functions/nightly-dispatch-background', { method: 'POST', headers: { 'x-hold-key': 'nope' }, body: JSON.stringify({ due: 1 }) }));
  assert.equal(res.status, 403);
});

test('decide: the rules on their own', () => {
  const a = (id, n, p) => ({ effect_id: id, kind: 'workers', payload: { action: 'assign', jobId: 'j', workerName: n, workerPhone: p } });
  const r = (id, ...ws) => ({ effect_id: id, kind: 'workers', payload: { action: 'remove', jobId: 'j', removedWorkers: ws.map(([n, p]) => ({ workerName: n, workerPhone: p })) } });
  const A = ['A', '+15550000011'], B = ['B', '+15550000012'];
  const led = [{ worker_key: 'p:5550000011', report_date: '2030-01-02' }];
  // A notified, B not; both removed in one Unschedule: only A's remove goes, right away.
  let out = dd.decide([a('1', ...B), r('2', A, B)], { crew: [], date: '', ledger: led, today: '2030-01-01', mode: 'removes' });
  assert.deepEqual(out.send.map(s => [s.action, s.payload.removedWorkers.map(w => w.workerName)]), [['remove', ['A']]]);
  assert.deepEqual([out.keep, out.drop], [['1'], []]);
  // At the 12 hours with nothing changed for a notified worker: nothing.
  out = dd.decide([r('3', A), a('4', ...A)], { crew: [{ name: 'A', phone: A[1] }], date: '2030-01-02', ledger: led, today: '2030-01-01' });
  assert.deepEqual([out.send.length, out.drop], [0, ['3', '4']]);
});

test('times changed after the crew was sent the job: ask, then text the new times once', async () => {
  stubFetch();
  jobsDb.push({ id: 'tc', name: '7 Times Way', sourceType: 'labor', contact: { name: 'Times Co' }, customFields: [] });
  await sql`update dispatch_feed_cache set data = ${JSON.stringify(jobsDb)} where key = 'ghl-jobs'`;
  await setState('tc', { jobAddress: '7 Times Way', reportDate: NEAR.date, reportTime: NEAR.time, reportEndDate: NEAR.date, reportEndTime: '', crew: [] });
  await boardAssign('tc', ANA); // inside 12 hours: sent now
  await setCrew('tc', [...(await crewOf('tc')), BO]); // Don't text: never sent
  const before = { reportDate: NEAR.date, reportTime: NEAR.time };
  let res = await (await effectHandler(new Request('https://board.test/api/workflow-effect?notified=tc'))).json();
  assert.deepEqual(res.workers.map(w => w.workerName), ['Ana Lopez'], 'only who was sent the job');
  const [r] = await sql`select data from job_shared_state where job_id = 'tc'`;
  const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  await setState('tc', { ...data, reportTime: '23:30', reportEndTime: '' });
  calls.make = []; calls.texts = [];
  const skip = await (await post({ op: 'times_changed', jobId: 'tc', resend: false, previous: before })).json();
  assert.deepEqual([skip.ok, calls.make.length, calls.texts.length], [true, 0, 0], "Don't text sends nothing");
  const [a, b] = await Promise.all([1, 2].map(() => post({ op: 'times_changed', jobId: 'tc', resend: true, previous: before }).then(x => x.json())));
  assert.equal([a, b].filter(x => x.duplicate).length, 1, 'double click: once');
  assert.deepEqual(calls.make.map(m => [m.action, m.workerName, m.timesChanged, m.reportTime, m.previousReportTime]), [['assign', 'Ana Lopez', true, '23:30', NEAR.time]]);
  assert.deepEqual(calls.texts.map(t => t.to), ['+15550000001']);
  assert.match(calls.texts[0].body, /11:30 PM/);
});
