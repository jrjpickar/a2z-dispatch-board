// Optional browser QA: after Assign selected on a job more than 12 hours out, Send now
// shows up on its own once the server has the held crew text (even when that takes seconds).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); const fs = require('fs'), path = require('path'), assert = require('assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true }); const context = await browser.newContext();
  const errors = []; let held = false;
  let job = { jobId: 'job1', version: 1, active: true, crew: [], reportDate: '2026-12-01', reportTime: '07:00', reportEndDate: '2026-12-01', reportEndTime: '15:30' };
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()); const reply = j => route.fulfill({ json: j });
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply(req.method() === 'GET' ? { signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'picker' } : {});
    if (u.pathname === '/api/dashboard-data') return reply({ jobs: [{ id: 'job1', name: '12 Main St', sourceType: 'labor', contact: { name: 'Client' }, customFields: [] }], sharedState: [job] });
    if (u.pathname === '/api/roster') return reply(u.searchParams.get('kind') === 'labor' ? [{ id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }] : []);
    if (u.pathname === '/api/shared-state') {
      if (req.method() === 'GET') return reply({ sharedState: [job], pendingSync: [] });
      const b = req.postDataJSON(); if (b.action === 'assign') job = { ...job, crew: [...job.crew, ...b.crewChanges.map(w => ({ id: w.contactId, name: w.workerName, phone: w.workerPhone }))], version: job.version + 1 };
      return reply({ ok: true, record: job });
    }
    if (u.pathname === '/api/workflow-effect') {
      if (req.method() === 'GET' && u.searchParams.get('crewText') === 'pending') return reply({ pending: held ? [{ effectId: 'e1', jobId: 'job1', dueAt: '2026-11-30T23:00:00.000Z', workers: ['Ana Lopez'] }] : [] });
      if (req.method() === 'POST') { const b = req.postDataJSON(); if (b.kind === 'crew_text') { await new Promise(r => setTimeout(r, 3000)); held = true; return reply({ ok: true, scheduled: true }); } return reply({ ok: true }); }
      return reply({ issues: [] });
    }
    if (u.pathname === '/api/manual-workers') return reply({ workers: [], hidden: [] });
    return reply({});
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => document.getElementById('jobsBody').innerText.includes('12 Main St'));
  assert.equal(await page.$('.job-crewtext-now'), null);
  await page.evaluate(() => { const b = [...document.querySelectorAll('#jobsBody button')].find(x => /assign crew/i.test(x.textContent)); b.click(); });
  await page.waitForSelector('.crew-worker-select', { state: 'attached' });
  await page.evaluate(() => { const cb = [...document.querySelectorAll('.crew-worker-select')].find(c => c.dataset.name === 'Ana Lopez'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForSelector('.crew-assign-confirm', { state: 'visible' });
  await page.click('.crew-assign-confirm');
  await page.waitForSelector('.job-crewtext-now', { timeout: 15000 });
  assert.deepEqual(errors, []);
  console.log('held appears OK');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
