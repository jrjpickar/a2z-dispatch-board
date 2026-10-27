import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
Object.assign(process.env, { GHL_API_TOKEN: 'pit', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+19495550000',
  GHL_APP_CLIENT_ID: 'cid', GHL_APP_CLIENT_SECRET: 'secret', GHL_SMS_CONVERSATION_PROVIDER_ID: 'prov1' });
const { buildCrewSchedule, smsParts } = await import('../lib/crew-text.mjs');
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

test('crew_text texts everyone through Twilio, logs to GHL, and a retry only redoes what failed', async () => {
  await real.ensureSchema(sql);
  await sql`insert into dispatch_feed_cache (key, data, updated_at) values ('ghl-jobs', ${JSON.stringify(jobs)}, now())`;
  for (const s of states) { const { jobId, active, ...data } = s; await sql`insert into job_shared_state (job_id, version, active, data) values (${jobId}, 1, ${active}, ${JSON.stringify(data)})`; }
  await sql`insert into dispatch_settings (key, value) values ('ghl-oauth:QUcu2PEAxPV1sQm1GQCq', ${JSON.stringify({ access_token: 'at', refresh_token: 'rt', expiresAt: Date.now() + 3600e3, locationId: 'QUcu2PEAxPV1sQm1GQCq' })})`;
  const texts = [], logs = []; let failMario = true;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('api.twilio.com')) { const b = new URLSearchParams(init.body); texts.push({ to: b.get('To'), from: b.get('From'), body: b.get('Body') }); return Response.json({ sid: 'SM' + texts.length, from: b.get('From') }, { status: 201 }); }
    if (url.includes('/contacts/search/duplicate')) return Response.json({ contact: { id: 'cMario' } });
    if (url.includes('/conversations/search?')) { const c = new URL(url).searchParams.get('contactId'); return Response.json({ conversations: c === 'c3' ? [] : [{ id: 'conv-' + c }] }); }
    if (url.endsWith('/conversations/') && init.method === 'POST') return Response.json({ conversation: { id: 'conv-new-' + JSON.parse(init.body).contactId } });
    if (url.endsWith('/conversations/messages/inbound')) {
      const b = JSON.parse(init.body);
      assert.equal(init.headers.Authorization, 'Bearer at');
      if (b.conversationId === 'conv-cMario' && failMario) return Response.json({ message: 'boom' }, { status: 500 });
      logs.push(b); return Response.json({ messageId: 'm' + logs.length });
    }
    throw new Error('unexpected fetch ' + url);
  };
  const payload = { action: 'crewText', jobId: 'j1', reportDate: '2026-10-26', textWorkers: [
    { contactId: 'c1', workerName: 'Niko Reyes', workerPhone: '+15555550100' }, { contactId: 'c2', workerName: 'Julio Herrera', workerPhone: '+15555550101' },
    { contactId: 'c3', workerName: 'Jose Fabian', workerPhone: '+15555550102' }, { contactId: '', workerName: 'Mario Danna', workerPhone: '+15555550103' }] };
  await assert.rejects(sendWorkflow('crew_text', payload, 'r1:crew_text:x'), /Mario Danna: texted, GHL log failed/);
  assert.equal(texts.length, 4);
  assert.ok(texts.every(t => t.from === '+19495550000' && t.body.startsWith('MONDAY')));
  assert.equal(logs.length, 3);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['altId', 'conversationId', 'conversationProviderId', 'date', 'direction', 'message', 'type']);
  assert.equal(logs[0].type, 'SMS'); assert.equal(logs[0].direction, 'outbound');
  assert.ok(logs.some(l => l.conversationId === 'conv-new-c3'), 'conversation made when the worker has none'); assert.equal(logs[0].conversationProviderId, 'prov1'); assert.equal(logs[0].altId, 'SM1');
  // Retry: the day changed since, but the same text goes out and nobody is texted twice.
  await sql`update job_shared_state set data = data || '{"crew":[]}'::jsonb where job_id = 'j2'`;
  failMario = false;
  await sendWorkflow('crew_text', payload, 'r1:crew_text:x');
  assert.equal(texts.length, 4, 'no second text');
  assert.equal(logs.length, 4); assert.equal(logs[3].conversationId, 'conv-cMario'); assert.equal(logs[3].altId, 'SM4');
});

test('only the workers in this assignment get texted, with the whole day in the text', async () => {
  const texts = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('api.twilio.com')) { const b = new URLSearchParams(init.body); texts.push({ to: b.get('To'), body: b.get('Body') }); return Response.json({ sid: 'SMx' + texts.length }, { status: 201 }); }
    if (url.includes('/conversations/search?')) return Response.json({ conversations: [{ id: 'conv' }] });
    if (url.endsWith('/conversations/messages/inbound')) return Response.json({ messageId: 'm' });
    throw new Error('unexpected fetch ' + url);
  };
  await sendWorkflow('crew_text', { action: 'crewText', jobId: 'j1', reportDate: '2026-10-26', textWorkers: [{ contactId: 'c2', workerName: 'Julio Herrera', workerPhone: '(555) 555-0101' }] }, 'r2:crew_text:y');
  assert.deepEqual(texts.map(t => t.to), ['+15555550101']);
  assert.ok(texts[0].body.startsWith('MONDAY') && texts[0].body.includes('* Niko Reyes'));
});

test('a run without textWorkers (old board tab) texts nobody', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return Response.json({}); };
  await sendWorkflow('crew_text', { action: 'crewText', jobId: 'j1', reportDate: '2026-10-26' }, 'r3:crew_text:z');
  assert.equal(called, false);
});
