import test from 'node:test';
import assert from 'node:assert/strict';
import { eodWorkbookAttachment, readZip } from '../lib/eod-xlsx.mjs';
const layout = { Interior: 7, Exterior: 7, Grading: 5 };
const lines = Object.entries(layout).flatMap(([section, n]) => Array.from({ length: n }, (_, i) => ({ section, line: i + 1, description: '', qty: 0, rate: 0 })));
Object.assign(lines[0], { description: 'Skilled Labor <8 HR>', qty: 16, rate: 65 });
Object.assign(lines[8], { description: 'Full Truck Load', qty: 2, rate: 375 });
test('EOD sheet produces the filled Job Costing workbook as a base64 .xlsx', () => {
  const crewHours = [{ workerName: 'Ana Lopez', hoursWorked: 7.5 }, { workerName: 'Bob Ray', hoursWorked: 4, sentHome: true }];
  const file = eodWorkbookAttachment({ jobName: 'Acme - 123 Main', date: '2026-09-23', lines, crewHours });
  assert.equal(file.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(file.fileName, /^EOD Sheet - Acme - 123 Main - 2026-09-23\.xlsx$/);
  const entries = readZip(Buffer.from(file.data, 'base64'));
  assert.equal(entries.length, 20);
  const sheet = entries.find(e => e.name === 'xl/worksheets/sheet1.xml').data.toString('utf8');
  const cell = ref => sheet.match(new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`))[0];
  assert.match(cell('C2'), /Acme - 123 Main/);
  assert.match(cell('C3'), /09\/23\/2026/);
  assert.match(cell('B8'), /Skilled Labor &lt;8 HR&gt;/);
  assert.match(cell('E8'), /<f[^>]*>C8\*D8<\/f><v>1040<\/v>/);
  assert.match(cell('E20'), /<v>750<\/v>/);
  assert.match(cell('E37'), /<v>1790<\/v>/);
  // No markup: rows 38-39 are now the Crew hours block (hours only, no pay rates).
  assert.doesNotMatch(sheet, /Markup|TOTAL PRICE|E37\*\(1\+E38\)/);
  assert.match(cell('A39'), /CREW HOURS/);
  assert.match(cell('A41'), /Ana Lopez/); assert.match(cell('E41'), /<v>7.5<\/v>/);
  assert.match(cell('A42'), /Bob Ray \(sent home\)/); assert.match(cell('E42'), /<v>4<\/v>/);
  assert.match(cell('A43'), /TOTAL CREW HOURS/); assert.match(cell('E43'), /<f>SUM\(E41:E42\)<\/f><v>11.5<\/v>/);
  assert.match(sheet, /<mergeCell ref="A41:D41"\/>/); assert.doesNotMatch(sheet, /A38:D38/);
});
import { eodMultipart, assertEodPayload } from '../lib/eod-xlsx.mjs';
test('EOD goes to Make as multipart with the workbook as binary and flat fields intact', async () => {
  const payload = { action: 'eod_sheet', jobId: 'opp123', jobName: 'Acme', date: '2026-09-23', lines, INTERIOR_LABOR_DESC: 'Skilled Labor', nightWork: false, crew: ['Ana'] };
  const form = eodMultipart(payload, 'req:eod_sheet');
  const file = form.get('file');
  assert.equal(file.name, 'EOD Sheet - Acme - 2026-09-23.xlsx');
  assert.ok(file.size > 10000);
  assert.equal(readZip(Buffer.from(await file.arrayBuffer())).length, 20);
  assert.equal(form.get('INTERIOR_LABOR_DESC'), 'Skilled Labor');
  assert.equal(form.get('action'), 'eod_sheet');
  assert.equal(form.get('nightWork'), 'false');
  assert.deepEqual(JSON.parse(form.get('crew')), ['Ana']);
  assert.equal(JSON.parse(form.get('lines')).length, 19);
  assert.equal(form.get('eventId'), 'req:eod_sheet');
});
test('a blank EOD sheet is never posted', () => {
  assert.throws(() => assertEodPayload({ action: 'eod_sheet', jobId: 'x', lines: [{ description: '', qty: 0, rate: 0 }] }), /empty/);
  assert.throws(() => assertEodPayload({ action: 'eod_sheet', lines }), /empty/);
  assertEodPayload({ action: 'eod_sheet', jobId: 'x', lines });
});
import { sendWorkflow } from '../lib/effects.mjs';
test('sendWorkflow posts EOD as multipart and others as JSON, and needs ok:true', async () => {
  const calls = []; const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: calls.length !== 3 }), { status: 200 }); };
  try {
    const sent = await sendWorkflow('eod_sheet', { action: 'eod_sheet', jobId: 'j1', jobName: 'Acme', date: '2026-09-23', lines }, 'r:eod_sheet');
    assert.equal(sent.fileName, 'EOD Sheet - Acme - 2026-09-23.xlsx');
    assert.ok(calls[0].init.body instanceof FormData);
    await sendWorkflow('job_stage', { action: 'complete', jobId: 'j1' }, 'r:job_stage');
    assert.equal(JSON.parse(calls[1].init.body).eventId, 'r:job_stage');
    await assert.rejects(sendWorkflow('workers', { action: 'assign', jobId: 'j1' }, 'r:w'), /did not answer/);
  } finally { globalThis.fetch = original; }
});
test('job log posts JSON to its own webhook, with the crew in assignedWorkers', async () => {
  const calls = []; const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); };
  try {
    const crew = [{ contactId: 'c1', workerName: 'Ana', workerPhone: '555' }];
    await sendWorkflow('job_log', { jobId: 'j1', action: 'eod_sheet', jobAddress: '1 Main', reportDate: '2026-10-01', assignedWorkers: crew }, 'r:job_log');
    assert.equal(calls[0].url, 'https://hook.us2.make.com/vqurtuiuxdbg9k1j7v03prsffquvh1xa');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual([body.jobId, body.eventId, body.assignedWorkers], ['j1', 'r:job_log', crew]);
    assert.equal(body.file, undefined);
  } finally { globalThis.fetch = original; }
});
