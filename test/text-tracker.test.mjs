// Schedule texts that never went out: the timer restarts a runner that died, the text step
// no longer skips workers silently, owed texts are caught up, and the Admin tracker shows it all.
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
const { textTracker } = await import('../lib/text-tracker.mjs');
const { default: statusHandler, twilioSignature } = await import('../netlify/functions/crew-text-status.mjs');
const blob = new Map();
timer.setTimerStore({ get: async k => blob.has(k) ? JSON.parse(blob.get(k)) : null, setJSON: async (k, v) => { blob.set(k, JSON.stringify(v)); } });
const sql = adapter(pg);
const { default: effectHandler } = await import('../netlify/functions/workflow-effect.mjs');
const post = body => effectHandler(new Request('https://board.test/api/workflow-effect', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://board.test' }, body: JSON.stringify(body) }));
const at = ms => { const p = dd.pacificParts(ms); return { date: p.date, time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` }; };
const FAR = at(Date.now() + 3 * 864e5), NEAR = at(Date.now() + 6 * 3600e3);
const ANA = { id: 'ca', name: 'Ana Lopez', phone: '+15550000001' }, BO = { id: 'cb', name: 'Bo Diaz', phone: '+15550000002' }, CY = { id: 'cc', name: 'Cy Ruiz', phone: '+15550000003' };
let calls, twilioFails = false, runnerStatus = 202, sidN = 0;
function stubFetch() {
  calls = { make: [], texts: [], runner: [], twilio: [] };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('hook.us2.make.com')) { calls.make.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    if (url.includes('api.twilio.com')) {
      const b = new URLSearchParams(init.body); calls.twilio.push(Object.fromEntries(b));
      if (twilioFails) return Response.json({ message: 'down' }, { status: 500 });
      calls.texts.push({ to: b.get('To'), body: b.get('Body') }); return Response.json({ sid: 'SM' + (++sidN) }, { status: 201 });
    }
    if (url.includes('nightly-dispatch-background')) { calls.runner.push(JSON.parse(init.body).due); return new Response(null, { status: runnerStatus }); }
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
let reqN = 0;
async function queue(kind, payload) {
  const requestId = 'req-' + (++reqN);
  await sql`insert into dispatch_requests (request_id, fingerprint, result) values (${requestId}, 'f', ${JSON.stringify({ ok: true, record: { jobId: payload.jobId } })}) on conflict do nothing`;
  return (await post({ requestId, kind, payload, effectKey: 'k' + reqN })).json();
}
const assign = (jobId, w) => ({ action: 'assign', jobId, contactId: w.id, workerName: w.name, workerPhone: w.phone });
const byName = (t, jobId) => Object.fromEntries(t.jobs.find(j => j.jobId === jobId).workers.map(w => [w.name, w.status]));

test('setup', async () => {
  await real.ensureSchema(sql); await dd.ensureHoldTables(sql);
  // The cached GHL feed only lists 'listed'. The other jobs are on the board but not in the feed.
  await sql`insert into dispatch_feed_cache (key, data, updated_at) values ('ghl-jobs', ${JSON.stringify([{ id: 'listed', name: '1 Listed St', sourceType: 'labor', contact: { name: 'L Co' }, customFields: [] }])}, now()) on conflict (key) do update set data = excluded.data`;
  await sql`insert into dispatch_settings (key, value) values ('ghl-oauth:QUcu2PEAxPV1sQm1GQCq', ${JSON.stringify({ access_token: 'at', refresh_token: 'rt', expiresAt: Date.now() + 3600e3, locationId: 'QUcu2PEAxPV1sQm1GQCq' })}) on conflict (key) do nothing`;
});

test('a job missing from the cached GHL feed still gets its text (it used to send nothing and show no error)', async () => {
  stubFetch();
  await setState('unlisted', { jobAddress: '9 Not In Feed', reportDate: NEAR.date, reportTime: NEAR.time, crew: [ANA] });
  const r = await queue('workers', assign('unlisted', ANA)); // inside 12 hours: goes now
  assert.equal(r.ok, true);
  assert.deepEqual(calls.texts.map(t => t.to), ['+15550000001']);
  assert.match(calls.texts[0].body, /9 Not In Feed/);
  assert.equal(calls.twilio[0].StatusCallback, 'https://board.test/api/crew-text-status', 'asks Twilio for the delivery report');
});

test('crew entry saved without a phone: texted with the phone from the run', async () => {
  stubFetch();
  await setState('nophone', { jobAddress: '10 Bare Crew', reportDate: NEAR.date, reportTime: NEAR.time, crew: [{ name: 'Bo Diaz' }] });
  await queue('workers', assign('nophone', BO));
  assert.deepEqual(calls.texts.map(t => t.to), ['+15550000002']);
});

test('owed text: the Make run went out but the send was cut off before the text; the runner catches it up', async () => {
  stubFetch();
  await setState('owed', { jobAddress: '11 Owed Ave', reportDate: NEAR.date, reportTime: NEAR.time, crew: [CY] });
  await sql`insert into crew_notify (job_id, report_date, worker_key, worker_name, worker_phone, contact_id, notified, effect_id, updated_at)
    values ('owed', ${NEAR.date}, 'p:5550000003', 'Cy Ruiz', '+15550000003', 'cc', true, 'x', now() - interval '10 minutes')`;
  assert.deepEqual((await dd.owedTexts(sql)).map(j => j.jobId), ['owed']);
  let t = await textTracker(sql);
  assert.equal(byName(t, 'owed')['Cy Ruiz'], 'overdue', 'tracker shows it as overdue');
  assert.ok(t.summary.problems >= 1);
  const out = await dd.runDue(sql, { gapMs: 0, log: () => {} });
  assert.ok(out.some(o => o.jobId === 'owed' && o.catchUp && o.texted === 1));
  assert.deepEqual(calls.texts.map(x => x.to), ['+15550000003']);
  assert.deepEqual(await dd.owedTexts(sql), []);
  t = await textTracker(sql);
  assert.equal(byName(t, 'owed')['Cy Ruiz'], 'sent');
});

test("tracker: waiting, Don't text and never queued; Text now sends once", async () => {
  stubFetch();
  await setState('far', { jobAddress: '12 Far Rd', reportDate: FAR.date, reportTime: '07:00', crew: [ANA] });
  await queue('workers', assign('far', ANA));
  await setState('near', { jobAddress: '13 Near Rd', reportDate: NEAR.date, reportTime: NEAR.time, crew: [BO, CY] });
  const dont = await (await post({ op: 'dont_text', jobId: 'near', reportDate: NEAR.date, workers: [{ workerName: 'Bo Diaz', workerPhone: BO.phone }] })).json();
  assert.equal(dont.recorded, 1);
  let t = await textTracker(sql);
  assert.equal(byName(t, 'far')['Ana Lopez'], 'pending');
  assert.deepEqual(byName(t, 'near'), { 'Bo Diaz': 'dont_text', 'Cy Ruiz': 'missed' });
  const cy = t.jobs.find(j => j.jobId === 'near').workers.find(w => w.name === 'Cy Ruiz');
  assert.equal(cy.canTextNow, true);
  const [a, b] = await Promise.all([1, 2].map(() => dd.sendWorkersNow(sql, 'near', { keys: [cy.key] })));
  assert.ok(a.ok && b.ok);
  assert.deepEqual(calls.make.filter(m => m.workerName === 'Cy Ruiz').length, 1, 'one Make assign run');
  assert.deepEqual(calls.texts.map(x => x.to), ['+15550000003']);
  t = await textTracker(sql);
  assert.deepEqual(byName(t, 'near'), { 'Bo Diaz': 'dont_text', 'Cy Ruiz': 'sent' });
});

test('failed text shows as failed with Retry, not as sent', async () => {
  stubFetch(); twilioFails = true;
  await setState('fail', { jobAddress: '14 Fail St', reportDate: NEAR.date, reportTime: NEAR.time, crew: [ANA] });
  await queue('workers', assign('fail', ANA));
  twilioFails = false;
  const w = (await textTracker(sql)).jobs.find(j => j.jobId === 'fail').workers[0];
  assert.deepEqual([w.status, w.canRetry, w.problem], ['failed', true, true]);
  assert.match(w.detail, /Twilio 500/);
});

test('Twilio delivery report: checked signature, delivered shows, a late "sent" never overwrites it', async () => {
  const send = (params, sig) => statusHandler(new Request('https://board.test/.netlify/functions/crew-text-status', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(params).toString() }));
  const [log] = await sql`select effect_id from crew_text_log where job_id = 'owed'`;
  const [step] = await sql`select ref from crew_text_sends where effect_id = ${log.effect_id} and step = 'sms:0'`;
  const sid = JSON.parse(step.ref).sid;
  const url = 'https://board.test/api/crew-text-status';
  const p1 = { MessageSid: sid, MessageStatus: 'delivered', To: '+15550000003' };
  assert.equal((await send(p1, 'bad')).status, 403);
  assert.equal((await send(p1, twilioSignature('tok', url, p1))).status, 204);
  const p2 = { MessageSid: sid, MessageStatus: 'sent', To: '+15550000003' };
  await send(p2, twilioSignature('tok', url, p2));
  const w = (await textTracker(sql)).jobs.find(j => j.jobId === 'owed').workers[0];
  assert.equal(w.status, 'delivered');
});

test('timer: a runner that never started or died is restarted; a failed start is retried', async () => {
  stubFetch();
  const getSql = async () => sql;
  const now = Date.now();
  // Start failed (HTTP 500): runnerFor stays empty so the next 5 minute check tries again.
  runnerStatus = 500;
  blob.set('next', JSON.stringify({ nextDue: now + 60e3, runnerFor: null, checkedAt: now }));
  let r = await timer.cronTick({ now, getSql });
  assert.equal(JSON.parse(blob.get('next')).runnerFor, null);
  runnerStatus = 202;
  r = await timer.cronTick({ now: now + 5 * 60e3, getSql });
  assert.equal(r.started, now + 60e3);
  // Started, but it never sent a heartbeat and the due time is 10 minutes gone: stuck.
  blob.set('next', JSON.stringify({ nextDue: now - 10 * 60e3, runnerFor: now - 10 * 60e3, checkedAt: now - 20 * 60e3, heartbeat: 0, restartAt: now - 20 * 60e3 }));
  calls.runner = [];
  r = await timer.cronTick({ now, getSql });
  assert.equal(r.stuck, true);
  // A heartbeat a minute ago: the runner is still working, leave it alone.
  blob.set('next', JSON.stringify({ nextDue: now - 10 * 60e3, runnerFor: now - 10 * 60e3, checkedAt: now - 20 * 60e3, heartbeat: now - 60e3, restartAt: now - 20 * 60e3 }));
  r = await timer.cronTick({ now, getSql });
  assert.deepEqual(r, { checked: 'blob' });
});

test('Acknowledge takes a red row out of Needs attention for everyone; Undo puts it back', async () => {
  const { ackTexts } = await import('../lib/text-tracker.mjs');
  const DAN = { id: 'cd', name: 'Dan Moss', phone: '+15550000004' };
  await setState('ackjob', { jobAddress: '14 Ack Ln', reportDate: NEAR.date, reportTime: NEAR.time, crew: [DAN] });
  let t = await textTracker(sql);
  let dan = t.jobs.find(j => j.jobId === 'ackjob').workers[0];
  assert.equal(dan.status, 'missed'); assert.equal(dan.problem, true);
  const before = t.summary.problems;
  assert.equal(await ackTexts(sql, { jobId: 'ackjob', items: [{ key: dan.key, status: dan.status }, { key: dan.key, status: 'sent' }], by: 'Jesse Pickar' }), 1, 'only red statuses are acknowledged');
  t = await textTracker(sql);
  const job = t.jobs.find(j => j.jobId === 'ackjob'); dan = job.workers[0];
  assert.equal(dan.status, 'missed', 'status stays honest');
  assert.equal(dan.problem, false); assert.equal(dan.acked.by, 'Jesse Pickar'); assert.equal(job.problems, 0);
  assert.equal(t.summary.problems, before - 1); assert.ok(t.summary.acknowledged >= 1);
  await ackTexts(sql, { jobId: 'ackjob', items: [{ key: dan.key, status: dan.status }], undo: true });
  t = await textTracker(sql);
  assert.equal(t.jobs.find(j => j.jobId === 'ackjob').workers[0].problem, true);
  await assert.rejects(ackTexts(sql, { jobId: 'nojob', items: [{ key: 'x', status: 'missed' }] }), /no date/);
});
