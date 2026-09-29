// Optional browser QA: Send schedule now -> worker webhook with action rapid_assign.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); const fs = require('fs'), path = require('path'), assert = require('assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true }); const context = await browser.newContext();
  const effects = []; const errors = [];
  let job = { jobId: 'job1', version: 1, active: true, crew: [], reportDate: '2026-09-29', reportTime: '07:00', reportEndDate: '2026-09-29', reportEndTime: '15:30' };
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()); const reply = j => route.fulfill({ json: j });
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply(req.method() === 'GET' ? { signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'picker' } : {});
    if (u.pathname === '/api/dashboard-data') return reply({ jobs: [{ id: 'job1', name: '12 Main St', sourceType: 'labor', contact: { name: 'Client' }, customFields: [] }], sharedState: [job] });
    if (u.pathname === '/api/roster') return reply(u.searchParams.get('kind') === 'labor' ? [{ id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }, { id: 'w2', name: 'Bob Ray', phone: '+15555550101' }] : []);
    if (u.pathname === '/api/shared-state') {
      if (req.method() === 'GET') return reply({ sharedState: [job], pendingSync: [] });
      const b = req.postDataJSON(); if (b.action === 'assign') job = { ...job, crew: [...job.crew, ...b.crewChanges.map(w => ({ id: w.contactId, name: w.workerName, phone: w.workerPhone }))], version: job.version + 1 };
      return reply({ ok: true, record: job });
    }
    if (u.pathname === '/api/workflow-effect') { if (req.method() === 'POST') effects.push(req.postDataJSON()); return reply(req.method() === 'POST' ? { ok: true } : { issues: [] }); }
    if (u.pathname === '/api/manual-workers') return reply({ workers: [], hidden: [] });
    return reply({});
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => document.getElementById('jobsBody').innerText.includes('12 Main St'));
  const opened = await page.evaluate(() => { const b = [...document.querySelectorAll('#jobsBody button')].find(x => /assign crew/i.test(x.textContent)); if (b) b.click(); return !!b; });
  assert.ok(opened, 'assign crew button');
  await page.waitForSelector('.crew-worker-select', { state: 'attached' });
  await page.evaluate(() => { const cb = [...document.querySelectorAll('.crew-worker-select')].find(c => c.dataset.name === 'Ana Lopez'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForSelector('.crew-assign-rapid', { state: 'visible' });
  await page.screenshot({ path: '/tmp/rapid.png' });
  await page.click('.crew-assign-rapid');
  await page.waitForFunction(() => true); await page.waitForTimeout(800);
  assert.equal(effects.length, 1); assert.equal(effects[0].kind, 'workers'); assert.equal(effects[0].payload.action, 'rapid_assign'); assert.equal(effects[0].payload.workerName, 'Ana Lopez');
  assert.deepEqual(errors, []);
  console.log('rapid OK', JSON.stringify({ action: effects[0].payload.action, effectKey: effects[0].effectKey }));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
