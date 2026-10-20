// Optional browser QA: Logistics needs attention bar, Use suggested, bulk assign,
// booked times counting as saved, and Send reminder now.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
(async () => {
  const { mutateMove } = await import(pathToFileURL(path.resolve(__dirname, '../lib/state.mjs')));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
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
    if (u.pathname === '/.netlify/functions/logistics-documents') return reply({ ok: true, document: { id: '69f8730d-d5cf-4653-83d9-3529c621215d', name: 'proposal.pdf', type: 'application/pdf', size: 100, url: '/.netlify/functions/logistics-documents?id=69f8730d-d5cf-4653-83d9-3529c621215d' } });
    if (u.pathname === '/api/container-action') {
      const b = req.postDataJSON(); commits.push(b);
      const { data } = mutateMove(null, b);
      states.newcontainer123 = { ...data, moveId: 'newcontainer123', sourceOpportunityId: 'newcontainer123', version: 1 };
      return reply({ ok: true, state: states.newcontainer123, opportunityId: 'newcontainer123' });
    }
    if (u.pathname === '/api/logistics-reminder-now') { reminders.push(1); return reply({ ok: true, sent: true, summary: 'Logistics: 2 of 2 moves need attention. Labor: 1 of 3 labor jobs need attention.' }); }
    return reply({});
  });
  await page.goto('https://a2z.test/');
  await page.click('#logisticsViewTab');

  await page.waitForSelector('tr[data-move-key="m1"]');
  assert.equal(await page.locator('tr[data-move-key="m1"] [data-action="reset"]').innerText(), 'EOD Sheet');
  await page.click('#newContainerBtn');
  await page.fill('#containerFirstName', 'Maria'); await page.fill('#containerLastName', 'Gomez');
  await page.fill('#containerAddress', '12 Main Street'); await page.fill('#containerTime', '08:00');
  await page.selectOption('#containerPaymentTerms', 'net-7');
  await page.fill('#containerClientContact', 'Maria 555-1234');
  await page.fill('#containerPredictedEndDate', today);
  await page.fill('#containerScope', 'Full proposal scope'); await page.fill('#containerNotes', 'Access notes');
  await page.fill('#containerScheduledDays', 'Monday-Friday'); await page.fill('#containerScheduledHours', '8 hours/day');
  await page.fill('#containerOverweightTons', '2.25');
  await page.setInputFiles('#containerDocuments', { name: 'proposal.pdf', mimeType: 'application/pdf', buffer: Buffer.from('proposal') });
  await page.click('#submitContainerBook');
  await page.waitForFunction(() => !document.getElementById('containerSheet').classList.contains('open'));
  const booking = commits.find(b => b.action === 'create');
  assert.equal(booking.overweightTons, 2.25); assert.equal(booking.scopeOfWork, 'Full proposal scope');
  assert.equal(booking.notes, 'Access notes'); assert.equal(booking.documents[0].name, 'proposal.pdf');
  await page.locator('tr[data-move-key="newcontainer123"] [data-action="edit"]').click();
  assert.equal(await page.inputValue('#editContainerScope'), 'Full proposal scope');
  assert.match(await page.locator('#editContainerDocumentList').innerText(), /proposal.pdf/);
  await page.click('#cancelEditContainer');
  await page.locator('tr[data-move-key="newcontainer123"] [data-action="reset"]').click();
  assert.equal(await page.inputValue('#logisticsEodOverweightTons'), '2.25');
  assert.equal(await page.inputValue('#logisticsEodScope'), 'Full proposal scope');
  await page.fill('#logisticsEodOverweightTons', '3.5');
  await page.fill('#logisticsEodNotes', 'Finished hauling');
  await page.click('#submitLogisticsEod');
  await page.waitForFunction(() => !document.getElementById('logisticsEodSheet').classList.contains('open'));
  await page.waitForTimeout(150);
  const log = effects.find(e => e.kind === 'driver_log' && e.payload.action === 'jobLog');
  assert.equal(log.payload.overweightTons, 3.5); assert.equal(log.payload.documents[0].name, 'proposal.pdf');
  assert.equal(log.payload.scopeOfWork, 'Full proposal scope'); assert.equal(log.payload.notes, 'Finished hauling');
  assert.equal(states.newcontainer123.scheduledDate, '');
  assert.equal(states.newcontainer123.lastEodSheet.overweightTons, 3.5);
  assert.equal(states.newcontainer123.predictedEndDate, today);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/private/tmp/logistics-eod-result.png', fullPage: true });
  console.log('PASS: booking, document upload, edit restoration and EOD log/reset');
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
