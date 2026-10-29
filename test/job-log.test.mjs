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
test('Make attaches a PDF to a job log row (by eventId or jobId + date) and the board serves it', async () => {
  clearEnv();
  process.env.JOB_LOG_PUSH_SECRET = 's3cret';
  await push({ rows: [{ jobId: 'p1', action: 'eod_sheet', date: '2026-10-27', eventId: 'ev-77' }, { jobId: 'p2', action: 'eod_sheet', date: '2026-10-27' }, { jobId: 'p3', action: 'eod_sheet', date: '2026-10-27', pdfUrl: 'https://drive.example/p3.pdf' }] });
  const pdf = Buffer.from('%PDF-1.4\n%fake\n');
  const sendPdf = (q, body = pdf, secret = 's3cret', type = 'application/pdf') => handler(new Request('https://x.test/api/job-log?pdf=1&' + q, { method: 'POST', headers: { 'content-type': type, 'x-make-secret': secret }, body }));
  assert.equal((await sendPdf('eventId=ev-77', pdf, 'nope')).status, 401);
  assert.equal((await sendPdf('jobId=p2')).status, 400);
  assert.equal((await sendPdf('eventId=ev-77', Buffer.from('https://not-a-pdf'))).status, 400);
  assert.equal((await (await sendPdf('eventId=ev-77')).json()).ok, true);
  const form = new FormData(); form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'p2 EOD.pdf');
  const viaForm = await (await handler(new Request('https://x.test/api/job-log?pdf=1&jobId=p2&date=10/27/2026', { method: 'POST', headers: { 'x-make-secret': 's3cret' }, body: form }))).json();
  assert.equal(viaForm.attachedTo, 'job:p2|eod_sheet|2026-10-27');
  const rows = (await (await get('from=2026-10-27&to=2026-10-27')).json()).rows;
  const by = id => rows.find(r => r.jobId === id);
  assert.ok(by('p1').pdfId && by('p2').pdfId);
  assert.equal(by('p3').pdfUrl, 'https://drive.example/p3.pdf');
  const served = await get('pdf=' + by('p1').pdfId);
  assert.equal(served.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await served.arrayBuffer()).toString(), pdf.toString());
  assert.equal((await handler(new Request('https://x.test/api/job-log?pdf=' + by('p1').pdfId))).status, 401);
});
test('job log document: cleaned, totals from employee hours, template keys in the payload', async () => {
  const { cleanDoc, docPayload, docFromRow, weekEndingFor } = await import('../lib/job-log-doc.mjs');
  assert.equal(weekEndingFor('2026-10-22'), '2026-10-25');
  assert.equal(weekEndingFor('2026-10-25'), '2026-10-25');
  const start = docFromRow({ date: '2026-10-22', clientName: 'New Castle', jobAddress: '14851 Yorba St, Tustin', scopeOfWork: 'Demo', workers: [{ name: 'Niko', hours: 8 }, { name: 'Aldo', hours: 8 }] });
  assert.equal(start.totalHours, 16);
  const doc = cleanDoc({ ...start, employees: [...start.employees, { name: 'Jesus', hours: '6.5' }, { name: '', hours: '' }, { name: 'Bad', hours: 99 }],
    tools: ['Wheelbarrow', 'Wheelbarrow', 'Grinder'], disposal: [{ ticket: 'T1', site: 'Dump', amount: '$1,200.50' }, {}], notes: 'Rain delay', totalHours: 999 });
  assert.equal(doc.employees.length, 4);
  assert.equal(doc.employees[3].hours, null);
  assert.equal(doc.totalHours, 22.5);
  assert.deepEqual(doc.tools, ['Wheelbarrow', 'Grinder']);
  assert.deepEqual(doc.disposal, [{ ticket: 'T1', site: 'Dump', amount: 1200.5 }]);
  const p = docPayload(doc, { docId: 'event:e1', returnUrl: 'https://b.test/api/job-log?pdf=1&docId=event%3Ae1' });
  assert.equal(p.reportEndDate, '2026-10-22'); assert.equal(p.customerName, 'New Castle'); assert.equal(p.siteAddress, '14851 Yorba St, Tustin');
  assert.equal(p.employeeOne, 'Niko'); assert.equal(p.employeeThree, 'Jesus'); assert.equal(p.employeeTwenty, '');
  assert.equal(p.hoursThree, '6.5'); assert.equal(p.hours, '8\n8\n6.5\n'); assert.equal(p.totalHours, '22.5'); assert.equal(p.scopeOfWork, 'Demo');
  assert.equal(p.specialTools, 'Rain delay\n\nTools used: Wheelbarrow, Grinder'); assert.equal(p.toolWheelbarrow, '\u2612'); assert.equal(p.toolBackhoe, '\u2610');
  // V5 template loop rows: name, hours, description on the first row only.
  assert.deepEqual(p.employees.map(e => [e.name, e.hours, e.scopeOfWork]), [['Niko', '8', 'Demo'], ['Aldo', '8', ''], ['Jesus', '6.5', ''], ['Bad', '', '']]);
  assert.deepEqual(docPayload(cleanDoc({ workDone: 'Only scope' })).employees.map(e => e.scopeOfWork), ['Only scope']);
  assert.equal(p.ticket1Amount, '1200.50'); assert.equal(p.ticket2Number, '');
  assert.equal(docPayload(cleanDoc({ employees: [{ name: 'A', hours: 8 }, { name: 'B', hours: 8 }] })).hours, '8');
});
test('board saves the job log doc, Generate PDF posts it to the job_log_pdf webhook, and the PDF comes back by docId', async t => {
  clearEnv();
  process.env.JOB_LOG_PUSH_SECRET = 's3cret';
  const prev = globalThis.fetch; t.after(() => { globalThis.fetch = prev; });
  await push({ jobId: 'd1', action: 'eod_sheet', date: '2026-10-26', eventId: 'ev-d1', jobAddress: '1 Main', assignedWorkers: [{ workerName: 'Ana', hoursWorked: 8 }] });
  const row = (await (await get('from=2026-10-26&to=2026-10-26')).json()).rows.find(r => r.jobId === 'd1');
  assert.equal(row.docId, 'event:ev-d1');
  const post = (q, body, extra = {}) => handler(new Request('https://x.test/api/job-log?' + q, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', origin: 'https://x.test', 'sec-fetch-site': 'same-origin', ...extra }, body: JSON.stringify(body) }));
  assert.equal((await post('doc=1', { docId: row.docId, doc: {} }, { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' })).status, 403);
  const doc = { date: '2026-10-26', customer: 'Acme Co', siteAddress: '1 Main', employees: [{ name: 'Ana', hours: 8 }, { name: 'Bo', hours: 4 }], notes: 'ok' };
  assert.equal((await (await post('doc=1', { docId: row.docId, doc })).json()).doc.totalHours, 12);
  const loaded = await (await get('doc=' + encodeURIComponent(row.docId))).json();
  assert.equal(loaded.doc.customer, 'Acme Co'); assert.equal(loaded.savedBy, 'Sam');
  const sent = [];
  globalThis.fetch = async (url, opts) => { sent.push([url, JSON.parse(opts.body)]); return new Response('{"ok":true}'); };
  const gen = await (await post('generate=1', { docId: row.docId, doc, row })).json();
  assert.equal(gen.ok, true);
  assert.equal(sent[0][0], 'https://hook.us2.make.com/6i4gimll9ejpfujhvh7tasv3cwiqpjkj');
  const payload = sent[0][1];
  assert.equal(payload.customerName, 'Acme Co'); assert.equal(payload.employeeTwo, 'Bo'); assert.equal(payload.totalHours, '12'); assert.equal(payload.jobId, 'd1');
  assert.equal(payload.pdfReturnUrl, 'https://x.test/api/job-log?pdf=1&docId=event%3Aev-d1');
  // Same fields the job log scenario (scheduleForInvoices) already maps, and the row's own eventId.
  // The filled .docx goes to Make as base64 "data", and is already on the row.
  const { readZip } = await import('../lib/eod-xlsx.mjs');
  const filled = readZip(Buffer.from(payload.data, 'base64')).find(e => e.name === 'word/document.xml').data.toString();
  const text = filled.replace(/<[^>]+>/g, '');
  assert.ok(!/\{\{/.test(text), 'no tags left'); assert.match(text, /Acme Co/); assert.match(text, /Ana/); assert.match(text, /Bo/);
  assert.equal(payload.fileName, 'Raw Job Log - 1 Main,2026-10-26.docx'); assert.equal(payload.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(gen.docxId);
  assert.equal(payload.action, 'job_log_edit'); assert.equal(payload.eventId, 'ev-d1'); assert.equal(payload.weekRange, '10/26-11/01');
  assert.deepEqual(payload.assignedWorkers, [{ workerName: 'Ana', hoursWorked: 8, sentHome: false }, { workerName: 'Bo', hoursWorked: 4, sentHome: false }]);
  assert.equal(payload.clientName, 'Acme Co'); assert.equal(payload.jobAddress, '1 Main'); assert.equal(payload.toolsRequired, 'ok');
  globalThis.fetch = prev;
  const back = await handler(new Request(payload.pdfReturnUrl, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-make-secret': 's3cret' }, body: Buffer.from('%PDF-1.7\n') }));
  assert.equal((await back.json()).attachedTo, 'event:ev-d1');
  const { execSync } = await import('node:child_process'); const { mkdtempSync, readFileSync: rf } = await import('node:fs'); const os = await import('node:os');
  const dir = mkdtempSync(os.tmpdir() + '/jl-'); execSync(`mkdir -p ${dir}/word && echo '<w:document/>' > ${dir}/word/document.xml && cd ${dir} && zip -qr f.docx word`);
  const docxBack = await (await handler(new Request(payload.pdfReturnUrl + '&name=Yorba%20Job%20Log.pdf', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-make-secret': 's3cret' }, body: rf(`${dir}/f.docx`) }))).json();
  assert.equal(docxBack.kind, 'docx'); assert.ok(docxBack.docxId);
  const after = (await (await get('from=2026-10-26&to=2026-10-26')).json()).rows.find(r => r.jobId === 'd1');
  assert.ok(after.pdfId); assert.equal(after.docEdited, true); assert.ok(after.docGeneratedAt);
  assert.ok(after.docxId); assert.notEqual(after.docxId, after.pdfId);
  const word = await get('pdf=' + after.docxId);
  assert.match(word.headers.get('content-type'), /wordprocessingml/); assert.match(word.headers.get('content-disposition'), /attachment; filename\*=UTF-8''Yorba%20Job%20Log\.docx/);
  globalThis.fetch = async () => new Response('Accepted');
  const refused = await post('generate=1', { docId: row.docId, doc, row });
  assert.equal(refused.status, 502); assert.match((await refused.json()).error, /Saved, but Make did not take it/);
  globalThis.fetch = prev;
});
test('board editor tool list matches the template list the payload uses', async () => {
  const { readFileSync } = await import('node:fs'); const vm = await import('node:vm');
  const { TOOL_GROUPS } = await import('../lib/job-log-doc.mjs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const src = html.slice(html.indexOf('const JLD_TOOLS = '), html.indexOf('let jldRow = null'));
  const ctx = vm.createContext({}); vm.runInContext(src.replace('const JLD_TOOLS', 'globalThis.JLD_TOOLS'), ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.JLD_TOOLS)), TOOL_GROUPS);
});
test('Word template: split tags merged, one table row per employee, text escaped, line breaks kept', async () => {
  const { buildJobLogDocx, mergeSplitTags } = await import('../lib/job-log-docx.mjs');
  const { readZip } = await import('../lib/eod-xlsx.mjs');
  assert.equal(mergeSplitTags('<w:r><w:t>{{</w:t></w:r><w:r><w:t>totalHours</w:t></w:r><w:r><w:t>}}</w:t></w:r>'),
    '<w:r><w:t xml:space="preserve">{{totalHours}}</w:t></w:r><w:r><w:t xml:space="preserve"></w:t></w:r><w:r><w:t xml:space="preserve"></w:t></w:r>');
  const out = buildJobLogDocx({ reportEndDate: '2026-10-22', customerName: 'A & B <Co>', siteAddress: '1 Main', totalHours: '12', specialTools: 'Line 1\nLine 2',
    employees: [{ name: 'Niko', hours: '8', scopeOfWork: 'Demo' }, { name: 'Aldo', hours: '4', scopeOfWork: '' }] });
  const xml = readZip(out).find(e => e.name === 'word/document.xml').data.toString();
  const text = xml.replace(/<[^>]+>/g, '');
  assert.ok(!text.includes('{{'));
  assert.match(xml, /A &amp; B &lt;Co&gt;/);
  assert.match(xml, /Line 1<\/w:t><w:br\/><w:t xml:space="preserve">Line 2/);
  const rows = xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g).filter(r => /Niko|Aldo/.test(r));
  assert.deepEqual(rows.map(r => r.replace(/<[^>]+>/g, '')), ['Niko8Demo', 'Aldo4']);
  assert.ok(readZip(out).some(e => e.name === 'word/media/image1.png'), 'logo kept');
});
