import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLayout, defaultLayout, canSee, PANELS } from '../lib/layout.mjs';
import { scheduleStats, valueStats, weekStart } from '../lib/dashboard-stats.mjs';

test('layout: fills missing panels, clamps sizes, drops unknown ids, keeps settings senior only', () => {
  const l = normalizeLayout({ panels: [{ id: 'history', w: 40, h: 50, audience: 'all' }, { id: 'bogus' }, { id: 'settings', audience: 'all', hidden: true }, { id: 'history', w: 3 }] });
  assert.equal(l.panels.length, PANELS.length);
  assert.deepEqual(l.panels[0], { id: 'history', w: 12, h: 0, hidden: false, audience: 'all' });
  assert.deepEqual(l.panels[1], { id: 'settings', w: 6, h: 0, hidden: true, audience: 'senior' });
  assert.equal(normalizeLayout({ panels: [{ id: 'admins', w: 1, h: 400 }] }).panels[0].w, 3);
  assert.equal(normalizeLayout({ panels: [{ id: 'admins', w: 6, h: 400 }] }).panels[0].h, 400);
});
test('layout: audience decides what a regular admin can use', () => {
  const l = defaultLayout();
  assert.equal(canSee(l, 'laborers', false), true);
  assert.equal(canSee(l, 'problems', false), false);
  assert.equal(canSee(l, 'problems', true), true);
  const shared = normalizeLayout({ panels: [{ id: 'problems', audience: 'all' }, { id: 'laborers', audience: 'senior' }] });
  assert.equal(canSee(shared, 'problems', false), true);
  assert.equal(canSee(shared, 'laborers', false), false);
});
test('stats: multi-day jobs count each day; crew counted once per day; closed jobs skipped', () => {
  const rows = [
    { active: true, data: { reportDate: '2026-10-01', reportEndDate: '2026-10-03', crew: [{ id: 'a' }, { id: 'b' }] } },
    { active: true, data: { reportDate: '2026-10-02', crew: [{ id: 'a' }] } },
    { active: false, data: { reportDate: '2026-10-02', status: 'completed', crew: [{ id: 'c' }] } }
  ];
  const s = scheduleStats(rows, '2026-09-30', 5);
  assert.deepEqual(s.chartJobs.series[0].values, [0, 1, 2, 1, 0]);
  assert.deepEqual(s.chartCrew.series[0].values, [0, 2, 2, 2, 0]);
});
test('stats: job value groups by Monday week and skips cancelled', () => {
  assert.equal(weekStart('2026-09-30'), '2026-09-28');
  const v = valueStats([
    { data: { reportDate: '2026-09-29', monetaryValue: '$1,200' } },
    { data: { reportDate: '2026-10-01', monetaryValue: 300 } },
    { data: { reportDate: '2026-10-01', monetaryValue: 999, status: 'cancelled' } }
  ], '2026-09-30');
  assert.equal(v.labels[v.currentIndex], '2026-09-28');
  assert.equal(v.series[0].values[v.currentIndex], 1500);
});
