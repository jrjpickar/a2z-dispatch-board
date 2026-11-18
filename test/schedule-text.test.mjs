import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateJob } from '../lib/state.mjs';
import { buildCrewSchedule } from '../lib/crew-text.mjs';
import { ledgerMatch } from '../lib/daily-dispatch.mjs';

test('notification ledger does not confuse two contacts sharing a phone', () => {
  const ledger = { contact_id: 'ana-1', worker_key: 'p:5550000001', worker_phone: '+15550000001', worker_name: 'Ana' };
  assert.equal(ledgerMatch(ledger, { id: 'ana-2', name: 'Ana', phone: '5550000001' }), false);
  assert.equal(ledgerMatch(ledger, { id: 'ana-1', name: 'Ana', phone: '5550000002' }), true);
});

test('assignment state retains custom times and renders only the recipient’s times', () => {
  const date = '2026-11-19';
  const job = { id: 'j', name: '123 Main St' };
  const workerTimes = { reportDate: date, reportTime: '07:00', reportEndDate: date, reportEndTime: '15:30', customTime: true };
  const { data } = mutateJob(null, { action: 'assign', reportDate: date, reportTime: '08:00', reportEndTime: '16:00', crewChanges: [
    { id: '1', name: 'Ana Lopez', phone: '+15550000001', workerTimes },
    { id: '2', name: 'Ana Diaz', phone: '+15550000002' }
  ] });
  assert.deepEqual(data.crew[0].workerTimes, workerTimes);
  const [schedule] = buildCrewSchedule([job], [{ ...data, jobId: 'j' }], date).jobs;
  assert.match(schedule.crew[0].text, /7:00 AM - 3:30 PM/);
  assert.match(schedule.crew[1].text, /8:00 AM - 4:00 PM/);
});

test('Pacific scheduling supports default, now, custom and past times and rejects after start', async () => {
  const { jobStartUtc, textPlan } = await import('../lib/daily-dispatch.mjs');
  const state = { reportDate: '2026-11-19', reportTime: '08:00' };
  const now = Date.parse('2026-11-18T08:00:00-08:00');
  assert.equal(Date.parse(textPlan(state, {}, now).textAt), jobStartUtc(state.reportDate, state.reportTime) - 12 * 3600e3);
  assert.deepEqual(textPlan(state, { textAtMode: 'now' }, now), { textAtMode: 'now', textAt: '2026-11-18T08:00:00.000-08:00' });
  const plan = textAt => textPlan(state, { textAtMode: 'custom', textAt }, now);
  assert.equal(Date.parse(plan('2026-11-18T11:15:00-08:00').textAt), Date.parse('2026-11-18T11:15:00-08:00'));
  assert.equal(Date.parse(plan('2026-11-18T07:45:00-08:00').textAt), now);
  assert.throws(() => plan('2026-11-19T08:15:00-08:00'), /before the job starts/);
  assert.throws(() => plan('2026-11-18T11:07:00-08:00'), /quarter hour/);
});

test('activity lists Pacific send time, custom hours and the next-day end for a night shift', async () => {
  const { scheduleActivity } = await import('../lib/activity.mjs');
  const times = { reportDate: '2026-11-19', reportTime: '23:00', reportEndDate: '2026-11-20', reportEndTime: '07:15', customTime: true };
  const a = scheduleActivity('Assigned', { jobId: 'j', jobAddress: '123 Main St', nightWork: true },
    { name: 'Juan Lopez' }, times, '2026-11-19T10:45:00-08:00');
  assert.match(a.target, /Juan Lopez at 123 Main St, Thu, Nov 19, 11:00 PM to Fri, Nov 20 7:15 AM \(custom, night\), text at Thu, Nov 19, 10:45 AM PT/);
  assert.equal(a.detail.textAt, '2026-11-19T10:45:00-08:00');
});
