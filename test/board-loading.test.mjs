import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
test('jobs render immediately while a slow roster continues loading', async () => {
  let finishRoster; const paints = [];
  const ctx = vm.createContext({ loadLaborRoster: () => new Promise(resolve => { finishRoster = resolve; }),
    loadDashboard: async () => {}, render: () => paints.push('paint') });
  vm.runInContext(html.slice(html.indexOf('async function refreshAll('), html.indexOf('/* ---------- Rendering ---------- */')), ctx);
  const refreshing = ctx.refreshAll({ fresh: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(paints.length, 1, 'jobs do not wait 1.5 seconds for the roster');
  finishRoster(); await refreshing;
  assert.equal(paints.length, 2);
});
test('simultaneous schedule reads share one request and a later refresh still reloads', async () => {
  let finish, requests = 0;
  const ctx = vm.createContext({ PS_URL: '/api/project-schedule', fetchJsonStrict: () => { requests++; return new Promise(resolve => { finish = resolve; }); },
    document: { getElementById: () => ({ hidden: true }) }, console, psRefreshButtons: () => {}, renderScheduleView: () => {} });
  vm.runInContext(html.slice(html.indexOf('let projectSchedulesLoading = null;'), html.indexOf('function psRefreshButtons()')), ctx);
  const first = ctx.loadProjectSchedules(), second = ctx.loadProjectSchedules();
  assert.equal(requests, 1); finish({ schedules: [] }); await Promise.all([first, second]);
  const third = ctx.loadProjectSchedules(); assert.equal(requests, 2); finish({ schedules: [] }); await third;
});
test('Refresh ignores repeated clicks until reads finish and restores the button', async () => {
  let handler, finish, reads = 0;
  const button = { disabled: false, addEventListener: (_event, fn) => { handler = fn; } };
  const ctx = vm.createContext({ document: { getElementById: id => id === 'refreshBtn' ? button : { hidden: true } }, boardEodMode: false,
    refreshAll: () => { reads++; return new Promise(resolve => { finish = resolve; }); }, loadProjectSchedules: async () => {} });
  vm.runInContext(html.slice(html.indexOf("document.getElementById('refreshBtn').addEventListener"), html.indexOf('const themeToggle')), ctx);
  const first = handler({ currentTarget: button });
  assert.equal(button.disabled, true);
  await handler({ currentTarget: button }); assert.equal(reads, 1);
  finish(); await first; assert.equal(button.disabled, false);
});
test('Admin Refresh delegates its roster refresh once', async () => {
  let handler, calls = 0;
  const button = { disabled: false, addEventListener: (_event, fn) => { handler = fn; } };
  const ctx = vm.createContext({ document: { getElementById: id => id === 'refreshBtn' ? button : { hidden: id !== 'adminDispatchView' } },
    renderAdminView: async force => { assert.equal(force, true); calls++; } });
  vm.runInContext(html.slice(html.indexOf("document.getElementById('refreshBtn').addEventListener"), html.indexOf('const themeToggle')), ctx);
  await handler({ currentTarget: button }); assert.equal(calls, 1); assert.equal(button.disabled, false);
});
