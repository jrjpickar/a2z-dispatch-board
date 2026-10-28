// Optional browser QA: Send now (next to Unschedule) shows for a job with a held crew text,
// needs a 5 second hold in its box, and posts only crew_text_send_now (no Make run).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); const fs = require('fs'), path = require('path'), assert = require('assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true }); const context = await browser.newContext();
  const posts = []; const errors = []; let held = true;
  const job = { jobId: 'job1', version: 2, active: true, crew: [{ id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }], reportDate: '2026-12-01', reportTime: '07:00', reportEndDate: '2026-12-01', reportEndTime: '15:30' };
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()); const reply = j => route.fulfill({ json: j });
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply(req.method() === 'GET' ? { signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'picker' } : {});
    if (u.pathname === '/api/dashboard-data') return reply({ jobs: [{ id: 'job1', name: '12 Main St', sourceType: 'labor', contact: { name: 'Client' }, customFields: [] }], sharedState: [job] });
    if (u.pathname === '/api/roster') return reply([]);
    if (u.pathname === '/api/shared-state') return reply({ sharedState: [job], pendingSync: [] });
    if (u.pathname === '/api/workflow-effect') {
      if (req.method() === 'GET' && u.searchParams.get('crewText') === 'pending') return reply({ pending: held ? [{ effectId: 'e1', jobId: 'job1', dueAt: '2026-11-30T23:00:00.000Z', workers: ['Ana Lopez'] }] : [] });
      if (req.method() === 'POST') { posts.push(req.postDataJSON()); held = false; return reply({ ok: true, sent: ['e1'], failed: [] }); }
      return reply({ issues: [] });
    }
    if (u.pathname === '/api/manual-workers') return reply({ workers: [], hidden: [] });
    return reply({});
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://a2z.test/');
  await page.waitForSelector('.job-crewtext-now', { timeout: 15000 });
  const sameLine = await page.evaluate(() => { const b = document.querySelector('.job-crewtext-now'); return !!b.closest('.status-line')?.querySelector('.job-unschedule'); });
  assert.ok(sameLine, 'Send now sits next to Unschedule');
  await page.click('.job-crewtext-now');
  await page.waitForSelector('#crewTextNowBackdrop:not([hidden])');
  assert.match(await page.textContent('#crewTextNowBody'), /Ana Lopez.*Mon, Nov 30, 3:00 PM Pacific.*nothing is sent to Make/s);
  await page.click('#crewTextNowConfirm'); await page.waitForTimeout(300);
  assert.equal(posts.length, 0, 'a plain click does not send');
  const box = await page.locator('#crewTextNowConfirm').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(5300); await page.mouse.up();
  await page.waitForTimeout(800);
  assert.deepEqual(posts, [{ op: 'crew_text_send_now', jobId: 'job1' }]);
  await page.waitForFunction(() => !document.querySelector('.job-crewtext-now'));
  await page.screenshot({ path: process.env.SHOT || '/tmp/send-now.png' });
  assert.deepEqual(errors, []);
  console.log('send now OK');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
