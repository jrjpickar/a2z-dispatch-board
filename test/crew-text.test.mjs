import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
Object.assign(process.env, { GHL_API_TOKEN: 'pit', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+19495550000',
  GHL_APP_CLIENT_ID: 'cid', GHL_APP_CLIENT_SECRET: 'secret', GHL_SMS_CONVERSATION_PROVIDER_ID: 'prov1' });
const { buildCrewSchedule, buildJobText, smsParts, pacificToUtc } = await import('../lib/crew-text.mjs');
const dd = await import('../lib/daily-dispatch.mjs');
const { sendWorkflow } = await import('../lib/effects.mjs');
const sql = adapter(pg);

const jobs = [
  { id: 'j1', name: '14851 Yorba St, Tustin', sourceType: 'demo', contact: { name: 'NEW CASTLE CONSTRUCTION' }, customFields: [] },
  { id: 'j2', name: '16 Burning Tree Rd, Newport Beach', sourceType: 'labor', contact: { name: 'Jason' }, customFields: [] },
  { id: 'j3', name: '12681 Harbor Blvd', sourceType: 'labor', contact: { name: 'McGuire Builders' }, customFields: [] },
  { id: 'j4', name: '1 Other St', sourceType: 'labor', contact: { name: 'Next Day' }, customFields: [] }
];
const day = { reportDate: '2026-10-26', reportEndDate: '2026-10-26' };
const states = [
  { jobId: 'j1', active: true, ...day, reportTime: '07:00', reportEndTime: '15:30', crew: [{ id: 'c1', name: 'Niko Reyes', phone: '(555) 555-0100' }, { id: 'c2', name: 'Julio Herrera', phone: '+15555550101' }] },
  { jobId: 'j2', active: true, ...day, reportTime: '07:00', reportEndTime: '15:30', crew: [{ id: 'c3', name: 'Jose Fabian', phone: '+15555550102' }, { id: 'c1', name: 'Niko Reyes', phone: '+15555550100' }] },
  { jobId: 'j3', active: true, ...day, reportTime: '22:00', reportEndTime: '06:00', nightWork: true, crew: [{ id: '', name: 'Mario Danna', phone: '+15555550103' }] },
  { jobId: 'j4', active: true, reportDate: '2026-10-27', reportTime: '07:00', reportEndTime: '15:30', crew: [{ id: 'c9', name: 'Other', phone: '+15555550109' }] }
];

test('schedule text matches the board format; workers once each in E.164', () => {
  const s = buildCrewSchedule(jobs, states, '2026-10-26');
  assert.equal(s.text, 'MONDAY\n\nOct 26, 2026\n\n3 jobs\n\n\n\n(NEW CASTLE CONSTRUCTION)\n\n14851 Yorba St, Tustin\n\n7:00 AM - 3:30 PM\n\n* Niko Reyes 4hr\n* Julio Herrera\n\n\n\n(HOURLY)\n\n(Jason)\n\n16 Burning Tree Rd, Newport Beach\n\n7:00 AM - 3:30 PM\n\n* Jose Fabian\n* Niko Reyes 4hr\n\n\n\n(HOURLY)\n\n(McGuire Builders)\n\n12681 Harbor Blvd\n\n10:00 PM - 6:00 AM\n\n* Mario Danna\n\n\n\nbuenas noches guys');
  assert.deepEqual(s.workers.map(w => w.phone), ['+15555550100', '+15555550101', '+15555550102', '+15555550103']);
});

test('long schedules split between jobs under the Twilio limit', () => {
  const parts = smsParts(['a'.repeat(900), 'b'.repeat(900), 'c'.repeat(100)]);
  assert.equal(parts.length, 2); assert.ok(parts.every(p => p.length <= 1500)); assert.ok(parts[1].startsWith('b'));
});


test('each job has its own text: day, date, that job, sign off', () => {
  const t = buildJobText(jobs, states, '2026-10-26', 'j2');
  assert.equal(t.text, 'MONDAY\n\nOct 26, 2026\n\n\n\n(HOURLY)\n\n(Jason)\n\n16 Burning Tree Rd, Newport Beach\n\n7:00 AM - 3:30 PM\n\n* Jose Fabian\n* Niko Reyes 4hr\n\n\n\nbuenas noches guys');
  assert.deepEqual(t.workers.map(w => w.phone), ['+15555550102', '+15555550100']);
  assert.equal(buildJobText(jobs, states, '2026-10-26', 'j4').text, '', 'job not on that day');
});

test('6:30 PM Pacific: next run time and which runs wait for it', () => {
  assert.equal(new Date(pacificToUtc('2026-10-26', '18:30')).toISOString(), '2026-10-27T01:30:00.000Z');
  assert.equal(new Date(pacificToUtc('2026-11-10', '18:30')).toISOString(), '2026-11-11T02:30:00.000Z');
  assert.equal(new Date(dd.nextDispatchUtc(Date.parse('2026-10-26T20:00:00Z'))).toISOString(), '2026-10-27T01:30:00.000Z'); // 1 PM -> today 6:30
  assert.equal(new Date(dd.nextDispatchUtc(Date.parse('2026-10-27T03:00:00Z'))).toISOString(), '2026-10-28T01:30:00.000Z'); // 8 PM -> tomorrow 6:30
  assert.equal(dd.waitsForNightly('workers', { action: 'assign' }), true);
  assert.equal(dd.waitsForNightly('workers', { action: 'remove' }), true);
  assert.equal(dd.waitsForNightly('split_day', { action: 'split_day_assign' }), true);
  assert.equal(dd.waitsForNightly('workers', { action: 'rapid_assign', rapidAssign: true }), false, 'Send schedule now goes right away');
  assert.equal(dd.waitsForNightly('split_day', { action: 'split_day_assign', sendNow: true }), false);
  assert.equal(dd.waitsForNightly('eod_sheet', { action: 'eod_sheet' }), false);
  assert.equal(dd.waitsForNightly('workers', { action: 'eod_sheet' }), false);
});

test('net change per worker: only what still stands goes to Make', () => {
  const a = (id, w) => ({ effect_id: id, payload: { action: 'assign', jobId: 'j', workerName: w, workerPhone: w === 'Ana' ? '+15550000001' : '+15550000002' } });
  const r = (id, ws) => ({ effect_id: id, payload: { action: 'remove', jobId: 'j', removedWorkers: ws.map(w => ({ workerName: w, workerPhone: w === 'Ana' ? '+15550000001' : w === 'Bo' ? '+15550000002' : '+15550000003' })) } });
  const ana = { name: 'Ana', phone: '+15550000001' }, bo = { name: 'Bo', phone: '+15550000002' };
  let out = dd.netChanges([a('1', 'Ana'), r('2', ['Ana'])], []);
  assert.deepEqual([out.send.length, out.drop], [0, ['1', '2']], 'assigned then removed: nothing');
  out = dd.netChanges([r('1', ['Ana']), a('2', 'Ana')], [ana]);
  assert.deepEqual([out.send.length, out.drop], [0, ['1', '2']], 'removed then put back: nothing');
  out = dd.netChanges([a('1', 'Ana'), r('2', ['Ana']), a('3', 'Ana')], [ana]);
  assert.deepEqual([out.send.map(s => s.row.effect_id), out.drop], [['3'], ['1', '2']], 'last assign wins');
  out = dd.netChanges([r('1', ['Ana', 'Bo', 'Cy']), a('2', 'Bo')], [bo]);
  assert.deepEqual(out.send[0].payload.removedWorkers.map(w => w.workerName), ['Ana', 'Cy'], 'unschedule run carries only who is still off');
  const fresh = dd.refreshAssign({ action: 'assign', reportTime: '07:00', workerReportTime: '07:00' }, { reportDate: '2026-10-29', reportTime: '08:00', reportEndDate: '2026-10-29', reportEndTime: '16:00' });
  assert.deepEqual([fresh.reportTime, fresh.workerReportTime, fresh.workerReportEndTime], ['08:00', '08:00', '16:00'], 'goes out with the times as they are now');
});

// ---------- Database: holding, Send now, the 6:30 PM run ----------
const D = '2026-10-29', T = '2026-10-30'; // "today" and tomorrow for the run below
const now630 = Date.parse('2026-10-30T01:30:00Z'); // Oct 29 6:30 PM Pacific
const jobsDb = [
  { id: 'k1', name: '1 Tomorrow St', sourceType: 'labor', contact: { name: 'Acme' }, customFields: [] },
  { id: 'k2', name: '2 Tomorrow St', sourceType: 'demo', contact: { name: 'Beta Co' }, customFields: [] },
  { id: 'k3', name: '3 Later Ave', sourceType: 'labor', contact: { name: 'Later Inc' }, customFields: [] }
];
const crew = (...ws) => ws.map(([id, name, phone]) => ({ id, name, phone }));
const ANA = ['ca', 'Ana Lopez', '+15550000001'], BO = ['cb', 'Bo Diaz', '+15550000002'], CY = ['cc', 'Cy Ruiz', '+15550000003'], DE = ['cd', 'De Paz', '+15550000004'];
let calls;
function stubFetch() {
  calls = { make: [], texts: [], ghl: 0 };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('hook.us2.make.com')) { calls.make.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    if (url.includes('api.twilio.com')) { const b = new URLSearchParams(init.body); calls.texts.push({ to: b.get('To'), body: b.get('Body'), at: Date.now() }); return Response.json({ sid: 'SM' + calls.texts.length }, { status: 201 }); }
    if (url.includes('/conversations/search?')) return Response.json({ conversations: [{ id: 'conv' }] });
    if (url.includes('/contacts/search/duplicate')) return Response.json({ contact: { id: 'cx' } });
    if (url.endsWith('/conversations/messages/inbound')) { calls.ghl++; return Response.json({ messageId: 'm' }); }
    throw new Error('unexpected fetch ' + url);
  };
}
const { default: effectHandler } = await import('../netlify/functions/workflow-effect.mjs');
const post = body => effectHandler(new Request('https://board.test/api/workflow-effect', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://board.test' }, body: JSON.stringify(body) }));
async function setState(jobId, data) {
  await sql`insert into job_shared_state (job_id, version, active, data) values (${jobId}, 1, true, ${JSON.stringify(data)})
    on conflict (job_id) do update set data = excluded.data, version = job_shared_state.version + 1`;
}
let reqN = 0;
async function queue(kind, payload) {
  const requestId = 'req-' + (++reqN);
  await sql`insert into dispatch_requests (request_id, fingerprint, result) values (${requestId}, 'f', ${JSON.stringify({ ok: true, record: { jobId: payload.jobId } })})`;
  return (await post({ requestId, kind, payload, effectKey: 'k' + reqN })).json();
}
const assignRun = (jobId, [id, name, phone], extra = {}) => ({ action: 'assign', jobId, contactId: id, workerName: name, workerPhone: phone, reportDate: T, reportTime: '07:00', ...extra });

test('assign and remove wait for 6:30 PM; Send schedule now goes right away; nothing hits Make on the click', async () => {
  await real.ensureSchema(sql);
  await sql`insert into dispatch_feed_cache (key, data, updated_at) values ('ghl-jobs', ${JSON.stringify(jobsDb)}, now()) on conflict (key) do update set data = excluded.data`;
  await sql`insert into dispatch_settings (key, value) values ('ghl-oauth:QUcu2PEAxPV1sQm1GQCq', ${JSON.stringify({ access_token: 'at', refresh_token: 'rt', expiresAt: Date.now() + 3600e3, locationId: 'QUcu2PEAxPV1sQm1GQCq' })}) on conflict (key) do nothing`;
  await setState('k1', { reportDate: T, reportTime: '07:00', reportEndDate: T, reportEndTime: '15:30', crew: crew(ANA, BO) });
  await setState('k2', { reportDate: T, reportTime: '06:30', reportEndDate: T, reportEndTime: '15:00', jobType: 'contract', crew: crew(CY) });
  await setState('k3', { reportDate: '2026-11-05', reportTime: '07:00', reportEndDate: '2026-11-05', reportEndTime: '15:30', crew: crew(DE) });
  stubFetch();
  let r = await queue('workers', assignRun('k1', ANA)); assert.equal(r.waitsForNightly, true);
  r = await queue('workers', assignRun('k1', BO)); assert.equal(r.waitsForNightly, true);
  r = await queue('workers', assignRun('k1', CY)); // Cy assigned to k1 then removed again before 6:30
  r = await queue('workers', { action: 'remove', jobId: 'k1', removedWorkers: [{ contactId: 'cc', workerName: 'Cy Ruiz', workerPhone: '+15550000003' }] });
  r = await queue('workers', assignRun('k2', CY));
  r = await queue('workers', assignRun('k3', DE, { reportDate: '2026-11-05' }));
  r = await queue('crew_text', { action: 'crewText', jobId: 'k1', reportDate: T, rapidAssign: false, textWorkers: [] });
  assert.equal(r.waitsForNightly, true);
  assert.deepEqual([calls.make.length, calls.texts.length], [0, 0], 'nothing sent on the click');
  const waiting = await (await effectHandler(new Request('https://board.test/api/workflow-effect?waiting=jobs'))).json();
  assert.deepEqual(waiting.jobs.k1, { changes: 4, names: ['Ana Lopez', 'Bo Diaz', 'Cy Ruiz'] });
  // Send schedule now (rapid) is not held.
  r = await queue('workers', { ...assignRun('k3', DE, { reportDate: '2026-11-05' }), action: 'rapid_assign', rapidAssign: true });
  assert.deepEqual(calls.make.map(m => m.action), ['rapid_assign']);
  const issues = await (await effectHandler(new Request('https://board.test/api/workflow-effect'))).json();
  assert.deepEqual(issues.issues, [], 'waiting runs are not problems');
});

test('Send now on a job sends it as it sits: net Make changes and the job text to whoever lacks it', async () => {
  stubFetch();
  const res = await (await post({ op: 'job_send_now', jobId: 'k2' })).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual([res.makeSent, res.texted], [1, 1]);
  assert.deepEqual(calls.make.map(m => [m.action, m.workerName]), [['assign', 'Cy Ruiz']]);
  assert.deepEqual(calls.texts.map(t => t.to), ['+15550000003']);
  assert.ok(calls.texts[0].body.includes('2 Tomorrow St') && !calls.texts[0].body.includes('1 Tomorrow St'), 'that job only');
  const again = await (await post({ op: 'job_send_now', jobId: 'k2' })).json();
  assert.deepEqual([again.makeSent, again.texted], [0, 0], 'nothing twice');
});

test('6:30 PM run: one job every 15 seconds, tomorrow texted, later jobs Make only, canceled-out changes dropped', async () => {
  stubFetch();
  const starts = [];
  const result = await dd.runNightly(sql, { now: now630, gapMs: 150, log: (...a) => starts.push(Date.now()) });
  assert.deepEqual(result.jobs.map(j => j.jobId), ['k2', 'k1', 'k3'], "tomorrow's jobs first by start (k2 6:30, k1 7:00), then the rest");
  // k1: Ana and Bo assigned (Cy canceled out); k2 already sent by Send now; k3: De assigned (job is next week, no text)
  assert.deepEqual(calls.make.map(m => [m.jobId, m.action, m.workerName]), [['k1', 'assign', 'Ana Lopez'], ['k1', 'assign', 'Bo Diaz'], ['k3', 'assign', 'De Paz']]);
  assert.deepEqual(calls.texts.map(t => t.to).sort(), ['+15550000001', '+15550000002'], "only tomorrow's crew who hadn't gotten it");
  assert.ok(calls.texts.every(t => t.body.startsWith('FRIDAY\n\nOct 30, 2026\n\n\n\n(HOURLY)\n\n(Acme)\n\n1 Tomorrow St')));
  assert.ok(starts[1] - starts[0] >= 140 && starts[2] - starts[1] >= 140, 'batches spaced out');
  const left = await sql`select status, count(*)::int as n from dispatch_effects where payload->>'jobId' like 'k%' and kind = 'workers' group by status order by status`;
  assert.deepEqual(left.map(r => [r.status, r.n]), [['cancelled', 2], ['confirmed', 5]]);
  const waiting = await (await effectHandler(new Request('https://board.test/api/workflow-effect?waiting=jobs'))).json();
  assert.deepEqual(waiting.jobs, {});
});

test('the 6:30 PM run is claimed once per day', async () => {
  assert.equal(await dd.claimNightly(sql, D), true);
  assert.equal(await dd.claimNightly(sql, D), false);
});

test('a crew text retry only redoes the GHL logs that failed, nobody is texted twice', async () => {
  await setState('k4', { reportDate: T, reportTime: '09:00', reportEndDate: T, reportEndTime: '12:00', crew: crew(['ce', 'Ed Mo', '+15550000005'], ['cf', 'Flo Re', '+15550000006']) });
  jobsDb.push({ id: 'k4', name: '4 Retry Rd', sourceType: 'labor', contact: { name: 'Retry' }, customFields: [] });
  await sql`update dispatch_feed_cache set data = ${JSON.stringify(jobsDb)} where key = 'ghl-jobs'`;
  stubFetch(); let failFlo = true;
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { if (String(url).endsWith('/conversations/messages/inbound') && failFlo && JSON.parse(init.body).altId === 'SM2') return Response.json({ message: 'boom' }, { status: 500 }); return base(url, init); };
  const payload = { action: 'crewText', jobId: 'k4', reportDate: T, textWorkers: [{ contactId: 'ce', workerName: 'Ed Mo', workerPhone: '+15550000005' }, { contactId: 'cf', workerName: 'Flo Re', workerPhone: '+15550000006' }] };
  await assert.rejects(sendWorkflow('crew_text', payload, 'retry:crew_text'), /GHL log failed/);
  assert.equal(calls.texts.length, 2);
  failFlo = false;
  await sendWorkflow('crew_text', payload, 'retry:crew_text');
  assert.equal(calls.texts.length, 2, 'no second text');
  assert.equal(calls.ghl, 2);
});

test('6:30 PM trigger: only acts 6:30 to 7:59 PM Pacific, once a day, and hands off with that day\'s key', async () => {
  process.env.URL = 'https://board.test'; process.env.SESSION_SECRET = 's3cret';
  const { default: trigger, nightlyKey } = await import('../netlify/functions/nightly-dispatch.mjs');
  const { default: background } = await import('../netlify/functions/nightly-dispatch-background.mjs');
  const realNow = Date.now; const hits = [];
  globalThis.fetch = async (url, init = {}) => { hits.push({ url: String(url), key: init.headers?.['x-nightly-key'] }); return new Response(null, { status: 202 }); };
  try {
    Date.now = () => Date.parse('2026-11-03T00:30:00Z'); // Nov 2 5:30 PM Pacific (PST)
    await trigger(); assert.equal(hits.length, 0, 'too early');
    Date.now = () => Date.parse('2026-11-03T02:30:00Z'); // Nov 2 6:30 PM Pacific
    await trigger(); await trigger();
    assert.equal(hits.length, 1, 'once a day');
    assert.equal(hits[0].url, 'https://board.test/.netlify/functions/nightly-dispatch-background');
    assert.equal(hits[0].key, nightlyKey('2026-11-02'));
    const denied = await background(new Request('https://board.test/.netlify/functions/nightly-dispatch-background', { method: 'POST', headers: { 'x-nightly-key': 'nope' } }));
    assert.equal(denied.status, 403);
  } finally { Date.now = realNow; }
});
