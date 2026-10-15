// Optional browser QA: Logistics needs attention bar, Use suggested, bulk assign,
// booked times counting as saved, and Send reminder now.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
(async () => {
  const { mutateMove } = await import(pathToFileURL(path.resolve(__dirname, '../lib/state.mjs')));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [], commits = [], effects = [], reminders = [];
  page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; let answer = true;
  page.on('dialog', d => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
  const today = ymd(new Date()), tomorrow = ymd(new Date(Date.now() + 864e5));
  const base = { sourceType: 'demo', targetType: 'job_addon', addonType: 'container', active: true, movementType: 'container_drop' };
  const states = {
    hist: { ...base, moveId: 'hist', sourceOpportunityId: 'opp1', clientName: 'Acme', jobAddress: '1 Acme Way', status: 'completed', active: false, closedDriverName: 'Joe Driver', closedAssetIds: ['t1'], closedAt: '2026-10-01T10:00:00Z', version: 3 },
    m1: { ...base, moveId: 'm1', sourceOpportunityId: 'opp1', clientName: 'Acme', jobAddress: '1 Acme Way', status: 'requested', requestedDate: today, requestedTime: '08:00', version: 1 },
    m2: { ...base, moveId: 'm2', sourceOpportunityId: 'opp2', clientName: 'Bolt', jobAddress: '2 Bolt Rd', status: 'scheduled', scheduledDate: tomorrow, scheduledTime: '07:00', version: 1 },
    m3: { ...base, moveId: 'm3', sourceOpportunityId: 'opp3', clientName: 'Cole', jobAddress: '3 Cole St', status: 'scheduled', scheduledDate: tomorrow, scheduledTime: '10:00', version: 1 }
  };
  const drivers = [{ id: 'd1', name: 'Joe Driver', phone: '+15555550111' }, { id: 'd2', name: 'Ana Driver', phone: '+15555550112' }];
  const assets = [{ id: 't1', name: 'Truck 12' }, { id: 't7', name: 'Truck 7' }];
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    const reply = json => route.fulfill({ json });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply({ signedIn: true, user: { id: 'u1', name: 'Jesse', email: 'j@x' }, via: 'ghl_sso', isAdmin: true });
    if (u.pathname === '/api/logistics-data') return reply({ moves: Object.values(states) });
    if (u.pathname === '/api/roster') {
      const kind = u.searchParams.get('kind');
      if (kind === 'assets') return reply(assets.map(a => ({ ...a, booked: Object.values(states).some(s => s.active !== false && (s.assets || []).some(x => x.assetId === a.id)) })));
      return reply(kind === 'drivers' ? drivers : []);
    }
    if (u.pathname === '/api/logistics-state') {
      if (req.method() === 'GET') return reply({ states: Object.values(states), serverTime: new Date().toISOString() });
      const b = req.postDataJSON(); commits.push(b);
      const cur = states[b.moveId];
      // Same rule as lib/store.mjs: a vehicle on another open move needs allowShared.
      if (b.action === 'assign_asset' && b.allowShared !== true && Object.values(states).some(s => s.moveId !== b.moveId && s.active !== false && !/complete|cancel/.test(s.status || '') && (s.assets || []).some(a => a.assetId === b.assetId)))
        return route.fulfill({ status: 409, json: { error: 'This asset is already assigned to another move.' } });
      try {
        const { data } = mutateMove(cur ? { data: cur } : null, b);
        states[b.moveId] = { ...data, moveId: b.moveId, version: (cur?.version || 0) + 1 };
        return reply({ ok: true, state: states[b.moveId] });
      } catch (error) { return route.fulfill({ status: 409, json: { error: error.message } }); }
    }
    if (u.pathname === '/api/workflow-effect') { if (req.method() === 'POST') effects.push(req.postDataJSON()); return reply(req.method() === 'POST' ? { ok: true } : { issues: [] }); }
    if (u.pathname === '/api/logistics-reminder-now') { reminders.push(1); return reply({ ok: true, sent: true, summary: '2 of 2 moves for tomorrow need attention: 2 no driver.' }); }
    return reply({});
  });
  await page.goto('https://a2z.test/');
  await page.click('#logisticsViewTab');
  await page.waitForSelector('#logisticsAttention:not([hidden])');
  const bar = () => page.locator('#logisticsAttention').innerText();
  assert.match(await bar(), /3 moves need attention/);
  assert.match(await bar(), /3 no driver/); assert.match(await bar(), /3 no vehicle/);
  assert.doesNotMatch(await bar(), /no time/, 'a booked date and time counts as saved');
  // m1 shows its booked time locked, no Lock button.
  assert.equal(await page.locator('tr[data-move-key="m1"] .logistics-schedule-lock').count(), 0);
  // Filter: only rows with no driver.
  await page.click('.logi-attn-filter[data-filter="driver"]');
  assert.equal(await page.locator('#logisticsMoves tr[data-move-key]').count(), 3);
  await page.click('.logi-attn-clear');
  // Use suggested on m1: last move on job opp1 had Joe Driver + Truck 12.
  const sug = page.locator('tr[data-move-key="m1"] .logi-suggest');
  assert.match(await sug.innerText(), /Use suggested: Joe Driver \+ Truck 12[\s\S]*on this job/);
  assert.equal(await page.locator('tr[data-move-key="m2"] .logi-suggest').count(), 0, 'no history, no suggestion');
  await page.screenshot({ path: process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, 'logistics.png') : '/dev/null' }).catch(() => {});
  await sug.click();
  await page.waitForFunction(() => /assigned/.test(document.getElementById('toast').innerText));
  await page.waitForTimeout(400);
  assert.equal(states.m1.driverName, 'Joe Driver'); assert.deepEqual(states.m1.assets.map(a => a.assetId), ['t1']);
  assert.ok(effects.some(e => e.kind === 'drivers' && e.payload.driverName === 'Joe Driver'), 'driver notification sent');
  // Bulk: select m2 and m3, Ana + Truck 7.
  await page.locator('tr[data-move-key="m3"] .logistics-select').check();
  await page.locator('tr[data-move-key="m2"] .logistics-select').check();
  assert.match(await page.locator('#logisticsBulk').innerText(), /2 selected/);
  await page.selectOption('.logi-bulk-driver', { label: 'Ana Driver' });
  await page.selectOption('.logi-bulk-asset', { label: 'Truck 7' });
  await page.click('.logi-bulk-apply');
  await page.waitForFunction(() => /Assigned:/.test(document.getElementById('toast').innerText));
  assert.equal(states.m2.driverName, 'Ana Driver'); assert.equal(states.m3.driverName, 'Ana Driver');
  assert.equal(dialogs.length, 1, 'one prompt for the bulk assign');
  assert.match(dialogs[0], /^Put Ana Driver and Truck 7 on all 2 selected moves\?\n  • 2 Bolt Rd[\s\S]*3 Cole St/);
  assert.deepEqual((states.m2.assets || []).map(a => a.assetId), ['t7']);
  assert.deepEqual((states.m3.assets || []).map(a => a.assetId), ['t7'], 'shared truck on both moves');
  assert.match(await page.locator('#toast').innerText(), /Ana Driver on 2 moves\. Truck 7 on 2 moves/);
  assert.equal(await page.locator('#logisticsBulk').isHidden(), true);
  await page.waitForTimeout(300);
  assert.match(await bar(), /fully assigned/);
  // Single move: Truck 12 is on m1 (today). Adding it to m3 asks first; Cancel leaves it alone.
  const row3 = page.locator('tr[data-move-key="m3"]');
  await row3.locator('.logistics-edit-asset').click().catch(() => {});
  await page.waitForSelector('tr[data-move-key="m3"] .logistics-asset-select');
  assert.match(await page.locator('tr[data-move-key="m3"] .logistics-asset-select').innerText(), /Truck 12 \(on 1 other move\)/);
  await page.selectOption('tr[data-move-key="m3"] .logistics-asset-select', 't1');
  answer = false;
  await page.click('tr[data-move-key="m3"] .logistics-assign-asset');
  assert.match(dialogs.at(-1), /Truck 12 is already on another open move:\n  • 1 Acme Way[\s\S]*Put it on this move \(3 Cole St/);
  await page.waitForTimeout(300);
  assert.deepEqual(states.m3.assets.map(a => a.assetId), ['t7'], 'cancelled: unchanged');
  answer = true;
  await page.click('tr[data-move-key="m3"] .logistics-assign-asset');
  await page.waitForFunction(() => /Truck 12 assigned/.test(document.getElementById('toast').innerText));
  assert.deepEqual(states.m3.assets.map(a => a.assetId), ['t7', 't1']);
  assert.equal(states.m3.assets[1].shared, true);
  // Driver: Joe is on m1; giving him m3 too asks first.
  await page.locator('tr[data-move-key="m3"] .logistics-edit-driver').click().catch(() => {});
  await page.waitForSelector('tr[data-move-key="m3"] .logistics-driver-select');
  assert.match(await page.locator('tr[data-move-key="m3"] .logistics-driver-select').innerText(), /Joe Driver \(on 1 other move\)/);
  await page.selectOption('tr[data-move-key="m3"] .logistics-driver-select', { label: 'Joe Driver (on 1 other move)' });
  await page.click('tr[data-move-key="m3"] .logistics-assign-driver');
  await page.waitForFunction(() => /Joe Driver assigned/.test(document.getElementById('toast').innerText));
  assert.match(dialogs.at(-1), /Joe Driver is already on another open move/);
  assert.equal(states.m3.driverName, 'Joe Driver'); assert.equal(states.m1.driverName, 'Joe Driver');
  await page.click('.logi-remind-now');
  await page.waitForFunction(() => /Reminder sent/.test(document.getElementById('toast').innerText));
  assert.equal(reminders.length, 1);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('Logistics smoke passed.');
})().catch(e => { console.error(e); process.exit(1); });
