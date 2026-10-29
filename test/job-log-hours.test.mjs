import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const date = '2026-10-29';
function payloadContext() {
  const context = vm.createContext({ dashboardData: { labor: [] }, getOpportunityValue: () => 0,
    getClientName: () => 'Customer', getClientCompany: () => 'Customer', getClientPhone: () => '', getScopeOfWork: () => 'Cleanup', getToolsRequired: () => '',
    getReportDate: () => date, getReportTime: () => '08:00', getReportEndDate: () => '', getReportEndTime: () => '16:00', localIsoDate: () => date });
  vm.runInContext(html.slice(html.indexOf('function toE164('), html.indexOf('// Scope of work, edited')), context);
  return context;
}
test('job log uses submitted individual hours, including sent-home and zero-hour employees', () => {
  const ctx = payloadContext();
  const rows = [{ workerName: 'Ana', hoursWorked: 8 }, { workerName: 'Bob', hoursWorked: 6.5 }, { workerName: 'Cy', hoursWorked: 4, sentHome: true }, { workerName: 'Dee', hoursWorked: 0 }];
  const payload = ctx.buildJobLogPayload({ id: 'j1', name: 'Main St' }, 'eod_sheet', date, rows);
  assert.equal(payload.hoursWorked, 18.5);
  assert.equal(payload.assignedWorkers.length, 4);
  assert.equal(payload.assignedWorkers[2].sentHome, true);
  assert.equal(payload.assignedWorkers[3].hoursWorked, 0);
  assert.equal(payload.reportEndDate, date);
  rows[0].hoursWorked = 99;
  assert.equal(payload.assignedWorkers[0].hoursWorked, 8, 'snapshot survives later input changes');
});
test('job log has no fixed employee count and rejects missing or invalid hours', () => {
  const ctx = payloadContext();
  const rows = Array.from({ length: 75 }, (_, n) => ({ workerName: `Worker ${n + 1}`, hoursWorked: 2.25 }));
  assert.equal(ctx.buildJobLogPayload({}, 'eod_sheet', date, rows).hoursWorked, 168.75);
  for (const hoursWorked of ['', null, undefined, NaN, -1, 25]) assert.throws(() => ctx.buildJobLogPayload({}, 'eod_sheet', date, [{ workerName: 'Ana', hoursWorked }]), /valid hours/);
});
test('completion after EOD queues only the stage update, never a second empty accounting log', async () => {
  const effects = [];
  const context = vm.createContext({ getSharedState: () => ({ eodSubmittedDates: [date] }), localIsoDate: () => date,
    dashboardData: { jobs: [{ id: 'j1' }] }, getNightWork: () => false, getReportDate: () => '', getReportTime: () => '', getReportEndDate: () => '', getReportEndTime: () => '',
    getCrew: () => [], getClientName: () => '', getClientCompany: () => '', getOpportunityValue: () => 0,
    CONFIG: { SHARED_STATE_SYNC_URL: '/api/shared-state' }, commitState: async () => {},
    queueClose: async args => effects.push(...args.effects), lastCommittedRequests: new Map([['j1', 'req-123']]), render: () => {}, showToast: () => {}, console });
  vm.runInContext(html.slice(html.indexOf('async function setJobStage('), html.indexOf('/* ---------- Undo window', html.indexOf('async function setJobStage('))), context);
  const button = { disabled: false };
  await context.setJobStage('j1', 'complete', button);
  assert.deepEqual(effects.map(e => e.kind), ['job_stage']);
  assert.equal(button.disabled, false);
});
