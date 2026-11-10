// Optional browser QA: Labor board crew chip "+ asset". Add a truck to a worker, warning when
// it is already with another worker or on a logistics move that day, Remove, and the
// Logistics vehicle picker labels it as with a crew.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
(async () => {
  const { mutateJob } = await import(pathToFileURL(path.resolve(__dirname, '../lib/state.mjs')));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [], commits = [], effects = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const today = ymd(new Date());
  const t = { reportDate: today, reportTime: '07:00', reportEndDate: today, reportEndTime: '15:30' };
  const ANA = { id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }, BOB = { id: 'w2', name: 'Bob Ray', phone: '+15555550101' };
  const state = {
    job1: { jobId: 'job1', version: 1, active: true, crew: [ANA], ...t },
    job2: { jobId: 'job2', version: 1, active: true, crew: [BOB], ...t }
  };
  const moves = { m1: { moveId: 'm1', sourceType: 'demo', targetType: 'job_addon', addonType: 'container', active: true, status: 'scheduled', scheduledDate: today, scheduledTime: '08:00', jobAddress: '9 Yard Rd', assets: [{ assetId: 't7', assetName: 'Truck 7' }], version: 1 } };
  const assets = [{ id: 't1', name: 'Truck 12' }, { id: 't7', name: 'Truck 7' }, { id: 'e1', name: 'Bobcat S70' }];
  const jobs = [{ id: 'job1', name: '1 Ana St', sourceType: 'labor', contact: { name: 'Client' }, customFields: [] }, { id: 'job2', name: '2 Bob Ave', sourceType: 'labor', contact: { name: 'Client' }, customFields: [] }];
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()); const reply = json => route.fulfill({ json });
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply({ signedIn: true, user: { id: 'u1', name: 'Jesse', email: 'j@x' }, via: 'ghl_sso', isAdmin: true });
    if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: Object.values(state) });
    if (u.pathname === '/api/roster') { const k = u.searchParams.get('kind'); return reply(k === 'labor' ? [ANA, BOB] : k === 'assets' ? assets : []); }
    if (u.pathname === '/api/logistics-data') return reply({ moves: Object.values(moves) });
    if (u.pathname === '/api/logistics-state') return reply({ states: Object.values(moves), serverTime: new Date().toISOString() });
    if (u.pathname === '/api/shared-state') {
      if (req.method() === 'GET') return reply({ sharedState: Object.values(state), pendingSync: [] });
      const b = req.postDataJSON(); commits.push(b); const cur = state[b.jobId];
      try { const { data, active } = mutateJob({ data: cur, active: true }, b); state[b.jobId] = { ...data, jobId: b.jobId, active, version: cur.version + 1 }; return reply({ ok: true, record: state[b.jobId] }); }
      catch (e) { return route.fulfill({ status: 409, json: { error: e.message } }); }
    }
    if (u.pathname === '/api/workflow-effect') { if (req.method() === 'POST') effects.push(req.postDataJSON()); return reply(req.method() === 'POST' ? { ok: true } : { issues: [] }); }
    if (u.pathname === '/api/manual-workers') return reply({ workers: [], hidden: [] });
    return reply({});
  });
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => document.getElementById('jobsBody').innerText.includes('2 Bob Ave'));
  const chipBtn = name => page.locator(`.crew-asset-btn[data-name="${name}"]`);
  assert.equal((await chipBtn('Ana Lopez').innerText()).trim(), '+ asset');
  // Ana takes Truck 12 (free): no warning.
  await chipBtn('Ana Lopez').click();
  await page.waitForFunction(() => document.querySelectorAll('#workerAssetSelect option').length > 1);
  const opts = await page.locator('#workerAssetSelect').innerText();
  assert.match(opts, /Truck 7 \(on 1 move that day\)/);
  await page.selectOption('#workerAssetSelect', 't1');
  await page.click('#workerAssetAdd');
  await page.waitForFunction(() => /Truck 12 is with Ana Lopez/.test(document.getElementById('toast').innerText));
  assert.deepEqual(state.job1.workerAssets.map(a => a.assetName), ['Truck 12']);
  assert.match(await page.locator('#workerAssetList').innerText(), /Truck 12/);
  await page.click('#workerAssetClose');
  assert.equal((await chipBtn('Ana Lopez').innerText()).trim(), 'Truck 12');
  // Bob: Truck 12 is with Ana today -> warning, Cancel, then Add anyway.
  await chipBtn('Bob Ray').click();
  await page.waitForFunction(() => /Truck 12 \(with Ana Lopez\)/.test(document.getElementById('workerAssetSelect').innerText));
  await page.selectOption('#workerAssetSelect', 't1');
  await page.click('#workerAssetAdd');
  await page.waitForSelector('#workerAssetWarn:not([hidden])');
  assert.match(await page.locator('#workerAssetWarn').innerText(), /already out that day[\s\S]*With Ana Lopez on 1 Ana St/);
  await page.screenshot({ path: process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, 'worker-asset-warn.png') : '/dev/null' }).catch(() => {});
  await page.click('#workerAssetCancelWarn');
  assert.equal(state.job2.workerAssets, undefined, 'cancel saves nothing');
  // Truck 7 is on a logistics move today -> warning too.
  await page.selectOption('#workerAssetSelect', 't7');
  await page.click('#workerAssetAdd');
  assert.match(await page.locator('#workerAssetWarn').innerText(), /On logistics move 9 Yard Rd/);
  await page.click('#workerAssetForce');
  await page.waitForFunction(() => /Truck 7 is with Bob Ray/.test(document.getElementById('toast').innerText));
  assert.deepEqual(state.job2.workerAssets.map(a => a.assetId), ['t7']);
  // Remove it.
  await page.click('.worker-asset-remove[data-asset-id="t7"]');
  await page.waitForFunction(() => /Truck 7 removed from Bob Ray/.test(document.getElementById('toast').innerText));
  assert.equal(state.job2.workerAssets, undefined);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#workerAssetBackdrop').isHidden(), true);
  // No webhooks or texts for asset changes.
  assert.equal(effects.length, 0);
  assert.ok(commits.every(c => c.action === 'set_worker_asset'));
  // Logistics: Truck 12 shows as with a crew in the vehicle picker.
  await page.click('#logisticsViewTab');
  await page.waitForSelector('tr[data-move-key="m1"]');
  await page.locator('tr[data-move-key="m1"] .logistics-edit-asset').click().catch(() => {});
  await page.waitForSelector('tr[data-move-key="m1"] .logistics-asset-select', { state: 'attached' });
  assert.match(await page.locator('tr[data-move-key="m1"] .logistics-asset-select').innerText(), /Truck 12 \(with crew: Ana Lopez\)/);
  assert.match(await page.locator('#logisticsAssets').innerText(), /With crew today: Ana Lopez \(1 Ana St\)/);
  assert.deepEqual(errors, []);
  console.log('Worker assets smoke passed.');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
