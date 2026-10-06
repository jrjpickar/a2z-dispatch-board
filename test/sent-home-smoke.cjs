// Optional browser QA: Worker sent home picks a worker and hours, releases them, and posts the webhook payload.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {
  const { mutateJob, checkVersion } = await import(pathToFileURL(path.resolve(__dirname, '../lib/state.mjs')));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [], effects = [];
  page.on('pageerror', e => errors.push(e.message));
  const jobs = [{ id: 'job00000001', name: '55 Elm St', sourceType: 'labor', contact: { id: 'c1', name: 'Client' }, customFields: [] }];
  let rec = { jobId: 'job00000001', version: 1, active: true, crew: [{ id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }, { id: 'w2', name: 'Bob Ray', phone: '+15555550101' }], reportDate: '2026-10-06', reportTime: '07:00', reportEndDate: '2026-10-06', reportEndTime: '15:30' };
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    const reply = json => route.fulfill({ json });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply(req.method() === 'GET' ? { signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'picker' } : {});
    if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: [rec] });
    if (u.pathname === '/api/roster') return reply(u.searchParams.get('kind') ? [] : [{ id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }, { id: 'w2', name: 'Bob Ray', phone: '+15555550101' }]);
    if (u.pathname === '/api/logistics-data') return reply({ moves: [] });
    if (u.pathname === '/api/workflow-effect') { if (req.method() === 'POST') effects.push(req.postDataJSON()); return reply(req.method() === 'POST' ? { ok: true } : { issues: [] }); }
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
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => document.getElementById('jobsBody').innerText.includes('Ana Lopez'));
  // The button sits in the top bar, left of Dark Mode.
  const order = await page.evaluate(() => [...document.querySelectorAll('.topbar .actions button')].map(b => b.id));
  assert.equal(order.indexOf('sentHomeBtn') + 1, order.indexOf('themeToggle'));
  await page.locator('#sentHomeBtn').click();
  assert.match(await page.locator('#sentHomeWorkers').innerText(), /Ana Lopez[\s\S]*55 Elm St/);
  assert.equal(await page.locator('#sentHomeConfirm').isDisabled(), true);
  await page.locator('#sentHomeWorkers label', { hasText: 'Ana Lopez' }).click();
  await page.selectOption('#sentHomeHours', '5.5');
  assert.match(await page.locator('#sentHomeConfirm').innerText(), /5\.5 h/);
  await page.screenshot({ path: process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, 'sent-home.png') : '/dev/null' }).catch(() => {});
  await page.locator('#sentHomeConfirm').click();
  await page.waitForFunction(() => document.getElementById('toast').innerText.includes('sent home'));
  await page.waitForTimeout(300);
  assert.deepEqual(rec.crew.map(w => w.name), ['Bob Ray']);
  assert.equal(rec.sentHome[0].hoursWorked, 5.5);
  const effect = effects.find(e => e.kind === 'worker_sent_home');
  assert.ok(effect, 'webhook effect posted');
  assert.equal(effect.payload.workerName, 'Ana Lopez');
  assert.equal(effect.payload.hoursWorked, 5.5);
  assert.equal(effect.payload.jobId, 'job00000001');
  assert.equal(effects.filter(e => e.kind === 'workers').length, 0, 'no removal text to the worker');
  assert.doesNotMatch(await page.locator('tr[data-job-row="job00000001"]').innerText(), /Ana Lopez/);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('Worker sent home smoke passed.', JSON.stringify(effect.payload));
})().catch(e => { console.error(e); process.exit(1); });
