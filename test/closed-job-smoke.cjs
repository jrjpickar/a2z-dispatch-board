// Optional browser QA: a job closed on the board but still active in GHL shows Reopen job, and works after reopening.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {
  const { mutateJob, checkVersion } = await import(pathToFileURL(path.resolve(__dirname, '../lib/state.mjs')));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const jobs = [{ id: 'job00000001', name: '55 Elm St', sourceType: 'labor', contact: { id: 'c1', name: 'Client' }, customFields: [] }];
  let rec = { jobId: 'job00000001', version: 2, active: false, status: 'completed', closedBy: 'Sam', closedAt: '2026-10-05T22:00:00Z', crew: [], reportDate: '2026-10-07', reportTime: '07:00', reportEndDate: '2026-10-07', reportEndTime: '15:00' };
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    const reply = json => route.fulfill({ json });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply(req.method() === 'GET' ? { signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'picker' } : {});
    if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: [rec] });
    if (u.pathname === '/api/roster') return reply(u.searchParams.get('kind') ? [] : [{ id: 'w1', name: 'Worker One', phone: '+15555550100' }]);
    if (u.pathname === '/api/logistics-data') return reply({ moves: [] });
    if (u.pathname === '/api/workflow-effect') return reply(req.method() === 'POST' ? { ok: true } : { issues: [] });
    if (u.pathname === '/api/shared-state') {
      if (req.method() === 'GET') return reply({ sharedState: [rec], pendingSync: [] });
      const payload = req.postDataJSON();
      try {
        checkVersion({ version: rec.version }, payload);
        const next = mutateJob({ version: rec.version, active: rec.active, data: rec }, payload);
        rec = { ...next.data, jobId: 'job00000001', active: next.active, version: rec.version + 1 };
        return reply({ ok: true, record: rec });
      } catch (error) { return route.fulfill({ status: error.status || 400, json: { error: error.message } }); }
    }
    return reply({});
  });
  jobs.push({ id: 'job00000002', name: '9 Oak Ave', sourceType: 'labor', contact: { id: 'c2', name: 'Oak Builders' }, customFields: [] });
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => document.getElementById('jobsBody').innerText.includes('9 Oak Ave'));
  // Closed jobs leave Labor Dispatch and the Jobs Scheduled count.
  assert.equal(await page.locator('tr[data-job-row="job00000001"]').count(), 0);
  assert.equal(await page.locator('#statScheduled').innerText(), '1');
  // Search bar filters the board.
  await page.fill('#jobSearch', 'zzz');
  assert.equal(await page.locator('#jobsBody tr[data-job-row]').count(), 0);
  assert.equal(await page.locator('#jobSearchCount').innerText(), '0 of 1');
  await page.fill('#jobSearch', 'oak');
  assert.equal(await page.locator('#jobsBody tr[data-job-row]').count(), 1);
  await page.fill('#jobSearch', '');
  // Completed tab lists it, flags that GHL still has it active, and can reopen it.
  await page.locator('#completedViewTab').click();
  const row = page.locator('tr[data-completed-row="job00000001"]');
  assert.match(await row.innerText(), /55 Elm St[\s\S]*by Sam[\s\S]*Completed[\s\S]*Still active in GHL/i);
  await page.fill('#completedSearch', 'nothing');
  assert.equal(await row.count(), 0);
  await page.fill('#completedSearch', 'elm');
  await page.screenshot({ path: process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, 'completed-tab.png') : '/dev/null' }).catch(() => {});
  await row.locator('.job-stage-btn.reopen').click();
  await page.waitForFunction(() => document.getElementById('toast').innerText.includes('Job reopened'));
  assert.equal(rec.active, true);
  assert.equal(await row.count(), 0);
  await page.locator('#laborViewTab').click();
  await page.waitForFunction(() => !!document.querySelector('tr[data-job-row="job00000001"]'));
  assert.equal(await page.locator('tr[data-job-row="job00000001"] .job-stage-btn.edit').count(), 1);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('Closed job smoke passed.');
})().catch(e => { console.error(e); process.exit(1); });
