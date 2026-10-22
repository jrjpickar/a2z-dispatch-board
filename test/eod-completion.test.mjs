import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mutateJob } from '../lib/state.mjs';
import { sendWorkflow } from '../lib/effects.mjs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const today = '2026-10-20';
test('EOD record survives reset and permits only its submitted day', () => {
  const initial = { active: true, data: { crew: [{ name: 'Ana' }], reportDate: today } };
  assert.throws(() => mutateJob(initial, { action: 'complete', requiredEodDate: today }), /EOD sheet/);
  const recorded = mutateJob(initial, { action: 'record_eod', date: today });
  assert.equal(recorded.data.crew.length, 1);
  const reset = mutateJob(recorded, { action: 'reset_dispatch' });
  assert.deepEqual(reset.data.eodSubmittedDates, [today]);
  assert.equal(mutateJob(reset, { action: 'complete', requiredEodDate: today }).active, false);
  assert.throws(() => mutateJob(reset, { action: 'complete', requiredEodDate: '2026-10-21' }), /EOD sheet/);
});
test('completion opens required EOD before disabling the completion button or committing', async () => {
  const opened = [];
  const context = vm.createContext({ getSharedState: () => ({ eodSubmittedDates: ['2026-10-19'] }), localIsoDate: () => today, openEodSheet: (...args) => opened.push(args), showToast: () => {} });
  vm.runInContext(html.slice(html.indexOf('async function setJobStage('), html.indexOf('/* ---------- Undo window', html.indexOf('async function setJobStage('))), context);
  const button = { disabled: false };
  await context.setJobStage('job-1', 'complete', button);
  assert.deepEqual(opened, [['job-1', button, true]]);
  assert.equal(button.disabled, false);
});
test('client weekdays stay lowercase without timezone date shifts', () => {
  const context = vm.createContext({});
  vm.runInContext(html.slice(html.indexOf('function jobDayOfWeek('), html.indexOf('function buildJobLogPayload(')), context);
  assert.equal(context.jobDayOfWeek('2026-10-20'), 'tuesday');
  assert.equal(context.jobDayOfWeek('2026-10-19'), 'monday');
});
test('job log and hours delivery normalize weekdays to lowercase', async () => {
  const previous = globalThis.fetch;
  try {
    const payloads = [];
    globalThis.fetch = async (_url, options) => { payloads.push(JSON.parse(options.body)); return new Response('{"ok":true}'); };
    await sendWorkflow('job_log', { reportDate: today, dayOfWeek: 'WRONG' }, 'log');
    await sendWorkflow('job_hours', { date: '2026-10-19' }, 'hours');
    assert.equal(payloads[0].dayOfWeek, 'tuesday');
    assert.equal(payloads[1].dayOfWeek, 'monday');
  } finally { globalThis.fetch = previous; }
});
test('webhooks include Monday-Sunday MM/DD week boundaries across years', async () => {
  const previous = globalThis.fetch;
  try {
    const payloads = [];
    globalThis.fetch = async (_url, options) => { payloads.push(JSON.parse(options.body)); return new Response('{"ok":true}'); };
    for (const [kind, date] of [['job_log', '2026-10-20'], ['job_hours', '2027-01-03'], ['job_log', '2026-12-28']]) {
      await sendWorkflow(kind, { date }, kind + date);
    }
    assert.deepEqual([payloads[0].weekStart, payloads[0].weekEnd, payloads[0].weekRange], ['10/19', '10/25', '10/19-10/25']);
    for (const payload of payloads.slice(1)) assert.deepEqual([payload.weekStart, payload.weekEnd, payload.weekRange], ['12/28', '01/03', '12/28-01/03']);
  } finally { globalThis.fetch = previous; }
});
test('a second EOD sheet on the same date gets its own request (no duplicate blocking) and still resets the day', () => {
  const start = { active: true, data: { crew: [{ name: 'Ana' }], reportDate: today, reportTime: '07:00' } };
  const first = mutateJob(start, { action: 'begin_eod', date: today, requestId: 'req-first-aaaaaaaaaa' });
  const reset = mutateJob(mutateJob(first, { action: 'record_eod', date: today }), { action: 'reset_dispatch' });
  assert.equal(reset.data.reportDate, '');
  assert.equal(reset.data.crew.length, 0);
  const second = mutateJob(reset, { action: 'begin_eod', date: today, requestId: 'req-second-bbbbbbbbb' });
  assert.equal(second.data.eodRequests[today], 'req-second-bbbbbbbbb');
  assert.deepEqual(mutateJob(second, { action: 'record_eod', date: today }).data.eodSubmittedDates, [today]);
});
test('job row shows the dates EOD sheets were completed', () => {
  const src = html.match(/function eodDoneNote[\s\S]*?\n}\n/)[0];
  const map = new Map([['j1', { eodSubmittedDates: ['2026-10-22', '2026-10-20', '2026-10-20'] }], ['j2', {}]]);
  const ctx = vm.createContext({ dashboardData: { sharedStateByJobId: map } });
  vm.runInContext(src, ctx);
  assert.match(ctx.eodDoneNote('j1'), /EOD completed on dates 10\/20, 10\/22</);
  assert.equal(ctx.eodDoneNote('j2'), '');
});
