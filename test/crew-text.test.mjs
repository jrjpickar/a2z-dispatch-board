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

// ---------- Editable text layout (Admin > Crew schedule text) ----------
test('crew text layout: default is unchanged, custom layouts render, empty lines drop cleanly', async () => {
  const ct = await import('../lib/crew-text.mjs');
  const sample = ct.renderCrewText(ct.CREW_TEXT_SAMPLE);
  assert.equal(sample, 'TUESDAY\n\nNov 3, 2026\n\n\n\n(Kyle Matt)\n\n267 E 16th St, Costa Mesa, CA 92627\n\n7:00 AM - 3:30 PM\n\n* Juanito Reyes\n* Guillermo 4hr\n* Jesus Reyes\n* Jose Manuel\n\n\n\nbuenas noches guys');
  const custom = { template: 'Hola! {WEEKDAY} {DATE}\n{SHIFT}\nCliente: {CLIENT}\nInicio: {START}\nFin: {END}\n\n{CREW}\n\nGracias', crewLine: '- {NAME} ({HOURS}h)' };
  const t = ct.renderCrewText({ ...ct.CREW_TEXT_SAMPLE, END: '' }, custom);
  assert.equal(t, 'Hola! Tuesday Nov 3, 2026\nCliente: Kyle Matt\nInicio: 7:00 AM\n\n- Juanito Reyes (h)\n- Guillermo (4h)\n- Jesus Reyes (h)\n- Jose Manuel (h)\n\nGracias');
  // Values are not re-read as fields (a client named "{CREW}" stays as typed).
  assert.match(ct.renderCrewText({ ...ct.CREW_TEXT_SAMPLE, CLIENT: '{CREW}' }), /\(\{CREW\}\)/);
});

test('crew text layout: bad layouts are refused with a clear reason', async () => {
  const { cleanCrewText } = await import('../lib/crew-text.mjs');
  const ok = { template: '{DATE}\n{ADDRESS}\n{TIME}\n{CREW}', crewLine: '* {NAME}' };
  assert.deepEqual(cleanCrewText(ok).warnings, []);
  assert.throws(() => cleanCrewText({ ...ok, template: '   \n ' }), /empty/);
  assert.throws(() => cleanCrewText({ ...ok, template: 'x'.repeat(1201) }), /too long/);
  assert.throws(() => cleanCrewText({ ...ok, template: '{DATE} {Adress}' }), /\{Adress\}/);
  assert.throws(() => cleanCrewText({ ...ok, template: '{DATE} {ADDRESS' }), /without its pair/);
  assert.throws(() => cleanCrewText({ ...ok, crewLine: '' }), /crew line is empty/);
  assert.throws(() => cleanCrewText({ ...ok, crewLine: '* {WORKER}' }), /\{WORKER\}/);
  assert.throws(() => cleanCrewText({ ...ok, crewLine: '* worker' }), /needs \{NAME\}/);
  assert.equal(cleanCrewText({ template: 'Hi {CLIENT}', crewLine: '{NAME}' }).warnings.length, 4, 'missing crew, day, address and time are warned about');
  assert.equal(cleanCrewText({ ...ok, template: '{DATE}\r\n{CREW}  \r\n\r\n' }).template, '{DATE}\n{CREW}', 'Windows line ends and trailing spaces cleaned');
});

test('crew text layout: a saved layout is used for real texts; a broken one falls back to the default', async () => {
  const ct = await import('../lib/crew-text.mjs');
  const fakeSql = value => async () => value === undefined ? [] : [{ value }];
  assert.deepEqual(await ct.readCrewText(fakeSql(undefined)), { ...ct.CREW_TEXT_DEFAULT });
  assert.deepEqual(await ct.readCrewText(fakeSql({ template: '{Nope}', crewLine: '{NAME}' })), { ...ct.CREW_TEXT_DEFAULT }, 'invalid saved layout never breaks a send');
  assert.deepEqual(await ct.readCrewText(async () => { throw new Error('db down'); }), { ...ct.CREW_TEXT_DEFAULT });
  const layout = { template: '{DATE}: {ADDRESS} {TIME}\n{CREW}', crewLine: '{NAME}' };
  const t = buildJobText(jobs, states, '2026-10-26', 'j2', { layout });
  assert.equal(t.text, 'Oct 26, 2026: 16 Burning Tree Rd, Newport Beach 7:00 AM - 3:30 PM\nJose Fabian\nNiko Reyes');
  assert.equal(ct.smsSegments('a'.repeat(160)), 1); assert.equal(ct.smsSegments('a'.repeat(161)), 2); assert.equal(ct.smsSegments('ó'.repeat(71)), 2);
});
