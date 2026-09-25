import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureSchema } from '../netlify/functions/db.mjs';
import {
  DEFAULT_PHASES, DEFAULT_SAFETY, buildSchedule, normalizeScheduleInput, projectSchedulePdf, sendProjectSchedule,
  saveProjectSchedule, listProjectSchedules, markProjectScheduleSent, workday, parseYmd, ymd
} from '../lib/project-schedule.mjs';

const example = normalizeScheduleInput({ jobId: 'opp-17k', jobName: 'Gomez - 4410 Harbor Blvd', start: '2026-10-05', mode: 'seq', phases: DEFAULT_PHASES, safety: DEFAULT_SAFETY });

test('crew and days are both entered: the default job is 27 days, 8 loads, 94 crew-days, peak crew 4', () => {
  const s = buildSchedule(example);
  assert.deepEqual(s.rows.map(r => [r.crew, r.days, r.from, r.to, r.loads]), [[3, 2, 1, 2, 2], [4, 6, 3, 8, 3], [4, 7, 9, 15, 1], [3, 5, 16, 20, 1], [3, 7, 21, 27, 1]]);
  assert.deepEqual([s.totalWorkdays, s.totalLoads, s.crewDays, s.peakCrew], [27, 8, 94, 4]);
  // Changing days never touches crew, and the other way round.
  const longer = buildSchedule({ ...example, phases: [{ ...DEFAULT_PHASES[1], days: 9 }] }).rows[0];
  assert.deepEqual([longer.crew, longer.days, longer.crewDays], [4, 9, 36]);
  const bigger = buildSchedule({ ...example, phases: [{ ...DEFAULT_PHASES[1], crew: 8 }] }).rows[0];
  assert.deepEqual([bigger.crew, bigger.days], [8, 6]);
});
test('separate crews all start Day 1', () => {
  const par = buildSchedule({ ...example, mode: 'par' });
  assert.equal(par.totalWorkdays, 7); assert.equal(par.peakCrew, 17);
  assert.ok(par.rows.every(r => r.from === 1));
});
test('custom layout: dragged start days, stretched durations, and overlap-aware peak crew', () => {
  const phases = DEFAULT_PHASES.map((p, i) => ({ ...p, startDay: [1, 3, 3, 16, 21][i] }));
  phases[1] = { ...phases[1], days: 9 };
  const s = buildSchedule({ ...example, mode: 'custom', phases });
  assert.deepEqual(s.rows.map(r => [r.from, r.to]), [[1, 2], [3, 11], [3, 9], [16, 20], [21, 27]]);
  assert.equal(s.peakCrew, 8);                              // drywall (4) + MEP (4) on site together
  assert.equal(s.totalWorkdays, 27);
  assert.equal(normalizeScheduleInput({ mode: 'custom', phases }).phases[3].startDay, 16);
});
test('schedules saved with square footage keep their crew, days and loads', () => {
  const legacy = normalizeScheduleInput({ sf: 17000, usable: 25, phases: [
    { name: 'Drywall Removal', rate: 800, yld: 3.5, plan: 'crew', crew: 4, days: 2 },
    { name: 'MEP Removal', rate: 700, yld: 1.2, plan: 'days', crew: 1, days: 3 }
  ] });
  assert.deepEqual(legacy.phases.map(p => [p.crew, p.days, p.loads]), [[4, 6, 3], [9, 3, 1]]);
  assert.equal('sf' in legacy, false);
});
test('workdays skip weekends', () => {
  assert.equal(ymd(workday(parseYmd('2026-10-05'), 27)), '2026-11-10');
  assert.equal(ymd(workday(parseYmd('2026-10-03'), 1)), '2026-10-05'); // Saturday start rolls to Monday
});
test('filled and blank PDFs render, even with characters Helvetica cannot draw', async () => {
  const filled = Buffer.from(await projectSchedulePdf({ ...example, jobName: 'Gomez 🏗 – Harbor' }));
  const blank = Buffer.from(await projectSchedulePdf(normalizeScheduleInput({}), { blank: true }));
  for (const pdf of [filled, blank]) assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});
test('Make receives the PDF as a binary file in multipart form data', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, form: init.body }; return new Response('Accepted'); };
  const result = await sendProjectSchedule(example, { fetchImpl, url: 'https://hook.example/test' });
  const file = seen.form.get('file');
  assert.equal(file.type, 'application/pdf');
  assert.equal(file.name, 'Project Schedule - Gomez - 4410 Harbor Blvd.pdf');
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal(seen.form.get('totalWorkdays'), '27');
  assert.equal(seen.form.get('plannedFinish'), '2026-11-10');
  assert.equal(JSON.parse(seen.form.get('phases')).length, 5);
  assert.equal(result.fileName, file.name);
  await assert.rejects(sendProjectSchedule(example, { fetchImpl: async () => new Response('nope', { status: 500 }), url: 'x' }), e => e.status === 502);
});

const pg = new PGlite();
function adapter(engine) {
  const sql = async (strings, ...values) => (await engine.query(strings.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), values)).rows;
  sql.json = value => JSON.stringify(value);
  sql.begin = cb => engine.transaction(tx => cb(adapter(tx)));
  return sql;
}
const sql = adapter(pg);
await ensureSchema(sql);
test('schedules are shared, versioned, and a stale save is refused', async () => {
  const first = await saveProjectSchedule(sql, example, 0);
  assert.equal(first.version, 1);
  const longer = { ...example, phases: example.phases.map((p, i) => i === 1 ? { ...p, days: 10 } : p) };
  const second = await saveProjectSchedule(sql, longer, 1);
  assert.equal(second.version, 2);
  await assert.rejects(saveProjectSchedule(sql, example, 1), e => e.status === 409);
  const sent = await markProjectScheduleSent(sql, example.jobId, 'x.pdf');
  assert.ok(sent.sentAt);
  const [listed] = await listProjectSchedules(sql);
  assert.equal(listed.input.phases[1].days, 10);
  assert.equal(listed.schedule.totalWorkdays, 31);
});
