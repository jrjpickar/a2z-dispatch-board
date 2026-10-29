import test, { mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { normalizeJobLog, toIsoDay } from '../lib/job-log.mjs';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
process.env.SESSION_SECRET ||= 'test-secret';
const { default: handler } = await import('../netlify/functions/job-log.mjs');
const { signSession } = await import('../lib/session.mjs');
const headers = { 'x-a2z-session': signSession({ id: 'u1', name: 'Sam' }, 'user_id') };
const get = async q => handler(new Request('https://x.test/api/job-log?' + q, { headers }));
const push = (body, secret = 's3cret') => handler(new Request('https://x.test/api/job-log', { method: 'POST', headers: { 'content-type': 'application/json', 'x-make-secret': secret }, body: JSON.stringify(body) }));
const clearEnv = () => { delete process.env.JOB_LOG_READ_WEBHOOK; delete process.env.JOB_LOG_PUSH_SECRET; };
test('job log rows normalize from sheet style and payload style columns', () => {
  const rows = normalizeJobLog({ rows: [
    { 'Job ID': 'job1', Action: 'complete', Date: '10/27/2026', 'Job Address': '55 Elm St', 'Client Name': 'Acme', 'Monetary Value': '$1,250', 'Hours Worked': '0', 'Assigned Workers': 'Ana Lopez, Bob Ray' },
    { jobId: 'job2', action: 'eod_sheet', reportDate: '2026-10-28', jobAddress: '9 Oak', hoursWorked: 16, assignedWorkers: [{ workerName: 'Ana', hoursWorked: 8 }, { workerName: 'Bob', hoursWorked: 8, sentHome: true }] },
    { jobId: 'old', action: 'eod_sheet', date: '2026-09-01' },
    { nothing: true }
  ] }, '2026-10-27', '2026-10-28');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-10-27');
  assert.equal(rows[0].monetaryValue, 1250);
  assert.deepEqual(rows[0].workers.map(w => w.name), ['Ana Lopez', 'Bob Ray']);
  assert.equal(rows[1].hoursWorked, 16);
  assert.equal(rows[1].workers[1].sentHome, true);
  assert.equal(rows[1].workers[0].hours, 8);
});
test('job log accepts a bare array and JSON text workers; rejects non rows', () => {
  const rows = normalizeJobLog([{ jobId: 'a', action: 'EOD Sheet', date: '2026-10-28', workers: '[{"workerName":"Cara","hoursWorked":"7.5"}]' }], '2026-10-28', '2026-10-28');
  assert.equal(rows[0].action, 'eod_sheet');
  assert.equal(rows[0].workers[0].hours, 7.5);
  assert.throws(() => normalizeJobLog('true'), /JSON array/);
  assert.equal(toIsoDay('2026-10-28T07:00:00Z'), '2026-10-28');
});
test('job log GET needs a session and explains when nothing is set up', async () => {
  clearEnv();
  assert.equal((await handler(new Request('https://x.test/api/job-log?from=2026-10-28'))).status, 401);
  const unset = await get('from=2026-10-28');
  assert.equal(unset.status, 503);
  assert.equal((await unset.json()).notSetUp, true);
});
test('Make pushes rows with x-make-secret; the board reads them by day; resends update in place', async () => {
  clearEnv();
  process.env.JOB_LOG_PUSH_SECRET = 's3cret';
  assert.equal((await push({ jobId: 'x', action: 'complete', date: '2026-10-28' }, 'nope')).status, 401);
  const first = await (await push({ rows: [
    { 'Job ID': 'j1', Action: 'eod_sheet', Date: '10/28/2026', 'Hours Worked': '16', eventId: 'e1', 'Assigned Workers': 'Ana, Bob' },
    { jobId: 'j1', action: 'complete', reportDate: '2026-10-28', monetaryValue: 4200 },
    { jobId: 'j2', action: 'eod_sheet', date: '2026-10-20' },
    { jobId: 'j3', action: 'eod_sheet' }
  ] })).json();
  assert.deepEqual([first.saved, first.skipped], [3, 1]);
  await push({ jobId: 'j1', action: 'eod_sheet', date: '2026-10-28', hoursWorked: 18, eventId: 'e1' });
  const day = await (await get('from=2026-10-28&to=2026-10-28')).json();
  assert.equal(day.rows.length, 2);
  assert.equal(day.rows.find(r => r.action === 'eod_sheet').hoursWorked, 18);
  const week = await (await get('from=2026-10-20&to=2026-10-28')).json();
  assert.equal(week.rows.length, 3);
  await push({ replaceFrom: '2026-10-20', replaceTo: '2026-10-28', rows: [{ jobId: 'j9', action: 'complete', date: '2026-10-21' }] });
  const resynced = await (await get('from=2026-10-20&to=2026-10-28')).json();
  assert.deepEqual(resynced.rows.map(r => r.jobId), ['j9']);
});
test('with JOB_LOG_READ_WEBHOOK set, the board asks Make for the range instead', async t => {
  clearEnv();
  const prev = globalThis.fetch;
  t.after(() => { globalThis.fetch = prev; clearEnv(); });
  process.env.JOB_LOG_READ_WEBHOOK = 'https://hook.test/read';
  const sent = [];
  globalThis.fetch = async (url, opts) => { sent.push([url, JSON.parse(opts.body)]); return new Response(JSON.stringify([{ jobId: 'j', action: 'complete', date: '2026-10-21' }])); };
  const ok = await (await get('from=2026-10-15&to=2026-10-21')).json();
  assert.deepEqual(sent, [['https://hook.test/read', { action: 'read', from: '2026-10-15', to: '2026-10-21' }]]);
  assert.equal(ok.rows.length, 1);
});
test('job log and EOD sheet use the contact company name, falling back to the contact name', async () => {
  const { readFileSync } = await import('node:fs'); const vm = await import('node:vm');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const slice = (a, b) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));
  const ctx = vm.createContext({ dashboardData: { labor: [] }, toE164: v => v, getClientPhone: () => '', getOpportunityValue: () => 100, getScopeOfWork: () => '', getToolsRequired: () => '',
    getReportDate: () => '2026-10-28', getReportTime: () => '', getReportEndDate: () => '', getReportEndTime: () => '', localIsoDate: () => '2026-10-28', jobWeekFields: () => ({}), jobDayOfWeek: () => 'wednesday' });
  vm.runInContext(slice('function getClientName(', 'function getClientPhone(') + slice('function buildJobLogPayload(', '// Scope of work, edited'), ctx);
  const withCompany = ctx.buildJobLogPayload({ id: 'j1', name: '55 Elm', contact: { name: 'Mike Jones', companyName: 'New Castle Construction' } }, 'eod_sheet', '2026-10-28', []);
  assert.equal(withCompany.clientName, 'New Castle Construction');
  assert.equal(withCompany.contactName, 'Mike Jones');
  assert.equal(ctx.getClientCompany({ contact: { name: 'Jason', companyName: '  ' } }), 'Jason');
  assert.match(html, /eodJobName'\).value = cleanEodText\(\[getClientCompany\(job\)/);
  assert.match(html, /action: 'eod_sheet', jobId, opportunityId: jobId, jobAddress: job.name \|\| '', clientName: getClientCompany\(job\)/);
});
