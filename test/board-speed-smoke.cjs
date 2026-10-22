// Browser QA for the faster board: lean feed, Refresh pulls fresh, Completed loads
// only when opened, unchanged rows are kept, unsaved typed times survive redraws.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  const errors = [], calls = [];
  const jobs = [1, 2, 3].map(i => ({ id: 'job' + i, name: i + ' Main St', sourceType: 'labor', contact: { name: 'Client ' + i }, customFields: [] }));
  const shared = jobs.map((j, i) => ({ jobId: j.id, version: 1, active: true, crew: [], scopeOfWork: 'Scope ' + i }));
  const oldClosed = { jobId: 'old1', version: 2, active: false, status: 'completed', closedAt: '2026-05-01T10:00:00Z', closedJobName: 'Old Closed Job' };
  let pollRecords = [];
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    u.searchParams.delete('_'); calls.push(u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : ''));
    const reply = json => route.fulfill({ json });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: shared, serverTime: '2026-10-22T18:00:00.000Z' });
    if (u.pathname === '/api/roster') return reply([{ id: 'w1', name: 'Worker', phone: '+15555550100' }]);
    if (u.pathname === '/api/shared-state' && u.searchParams.get('view') === 'closed') return reply({ sharedState: [oldClosed], serverTime: '2026-10-22T18:00:01.000Z' });
    if (u.pathname === '/api/shared-state') return reply({ sharedState: pollRecords, pendingSync: [], serverTime: '2026-10-22T18:00:02.000Z' });
    if (u.pathname === '/api/workflow-effect') return reply({ issues: [] });
    return reply({});
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => document.querySelectorAll('#jobsBody tr[data-job-row]').length === 3);

  // Opening the board uses the shared cache; nothing about closed jobs is loaded yet.
  assert.deepEqual(calls.filter(c => c.startsWith('/api/dashboard-data')), ['/api/dashboard-data']);
  assert.equal(calls.filter(c => c.includes('view=closed')).length, 0);

  // The first live check starts from the feed's serverTime (no full download).
  await page.evaluate(() => pollSharedState());
  assert.ok(calls.some(c => c.startsWith('/api/shared-state?since=2026-10-22T18')), calls.join(' '));

  // Unchanged rows are kept; a changed job's row is rebuilt.
  await page.evaluate(() => { window.__rows = [...document.querySelectorAll('#jobsBody tr[data-job-row]')]; render(); });
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('#jobsBody tr[data-job-row]')].every(r => window.__rows.includes(r))));
  await page.evaluate(() => { dashboardData.sharedStateByJobId.get('job2').scopeOfWork = 'Changed scope'; render(); });
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#jobsBody tr[data-job-row]')].filter(r => !window.__rows.includes(r)).map(r => r.dataset.jobRow)), ['job2']);
  assert.ok(await page.evaluate(() => document.querySelector('[data-job-row="job2"]').innerHTML.includes('Changed scope')));

  // A typed (unsaved) date survives a live update that rebuilds the row.
  await page.locator('[data-job-row="job1"] .report-date-input').fill('2026-10-30');
  pollRecords = [{ ...shared[0], version: 2, scopeOfWork: 'Updated elsewhere' }];
  await page.evaluate(() => { document.activeElement.blur(); return pollSharedState(); });
  assert.ok(await page.evaluate(() => document.querySelector('[data-job-row="job1"]').innerHTML.includes('Updated elsewhere')));
  assert.equal(await page.locator('[data-job-row="job1"] .report-date-input').inputValue(), '2026-10-30');
  pollRecords = [];

  // Refresh pulls the fresh feed and keeps the board on screen (no Loading jobs flash).
  await page.evaluate(() => document.getElementById('refreshBtn').click());
  assert.equal(await page.evaluate(() => document.getElementById('jobsBody').innerText.includes('Loading jobs')), false);
  await page.waitForFunction(() => true);
  await page.waitForTimeout(200);
  assert.ok(calls.includes('/api/dashboard-data?fresh=1'), calls.join(' '));

  // Completed loads closed jobs only when opened, once.
  await page.evaluate(() => document.querySelector('.dispatch-view-tab[data-view="completed"]').click());
  await page.waitForFunction(() => document.getElementById('completedBody').innerText.includes('Old Closed Job'));
  await page.evaluate(() => document.querySelector('.dispatch-view-tab[data-view="labor"]').click());
  await page.evaluate(() => document.querySelector('.dispatch-view-tab[data-view="completed"]').click());
  assert.equal(calls.filter(c => c.includes('view=closed')).length, 1);
  await page.evaluate(() => document.getElementById('refreshBtn').click());
  await page.waitForTimeout(200);
  assert.equal(calls.filter(c => c.includes('view=closed')).length, 2, 'Refresh on Completed reloads closed jobs');

  assert.deepEqual(errors, []);
  console.log('Board speed smoke passed.');
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
