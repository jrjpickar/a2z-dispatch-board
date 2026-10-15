// Optional browser QA: truck loads on a Logistics move, loadCount webhook for containers,
// jobLog on Reset Day, and contract job EOD sheets picking up the day's loads.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
(async () => {
  const { mutateMove, mutateJob } = await import(pathToFileURL(path.resolve(__dirname, '../lib/state.mjs')));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [], effects = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const today = ymd(new Date());
  const states = {
    add1: { moveId: 'add1', sourceType: 'demo', targetType: 'job_addon', addonType: 'container', sourceOpportunityId: 'demoJob1', jobAddress: '9 Demo Dr', status: 'assigned', active: true, scheduledDate: today, scheduledTime: '07:00', driverName: 'Joe Driver', assets: [{ assetId: 't1', assetName: 'Truck 12' }], version: 1 },
    add2: { moveId: 'add2', sourceType: 'demo', targetType: 'job_addon', addonType: 'container', sourceOpportunityId: 'demoJob1', jobAddress: '9 Demo Dr', status: 'scheduled', active: true, scheduledDate: today, scheduledTime: '09:00', version: 1 },
    box1: { moveId: 'box1', sourceType: 'container', targetType: 'standalone', addonType: 'container', sourceOpportunityId: 'box1', pipelineId: 'F8i8hB7E5xHrJbJUXFr4', jobAddress: '5 Bin Ln', clientName: 'Binco', containerSize: '30 Yard', movementType: 'container_swap', status: 'assigned', active: true, scheduledDate: today, scheduledTime: '08:00', driverName: 'Ana Driver', assets: [{ assetId: 't7', assetName: 'Truck 7' }], version: 1 }
  };
  let jobRec = { jobId: 'demoJob1', version: 1, active: true, crew: [{ id: 'w1', name: 'Cara Diaz', phone: '+15555550102' }], reportDate: today, reportTime: '07:00', reportEndDate: today, reportEndTime: '15:30' };
  const jobs = [{ id: 'demoJob1', name: '9 Demo Dr', sourceType: 'demo', pipelineStageId: 'bb901617-1ec6-4f3c-8c77-27ccafb96404', contact: { name: 'Demo Client' }, customFields: [] }];
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    const reply = json => route.fulfill({ json });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply({ signedIn: true, user: { id: 'u1', name: 'Jesse', email: 'j@x' }, via: 'ghl_sso', isAdmin: true });
    if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: [jobRec] });
    if (u.pathname === '/api/shared-state') {
      if (req.method() === 'GET') return reply({ sharedState: [jobRec], pendingSync: [] });
      const b = req.postDataJSON(); const next = mutateJob({ version: jobRec.version, active: jobRec.active, data: jobRec }, b);
      jobRec = { ...next.data, jobId: 'demoJob1', active: next.active, version: jobRec.version + 1 }; return reply({ ok: true, record: jobRec });
    }
    if (u.pathname === '/api/logistics-data') return reply({ moves: Object.values(states) });
    if (u.pathname === '/api/roster') { const k = u.searchParams.get('kind'); return reply(k === 'drivers' ? [{ id: 'd1', name: 'Joe Driver' }, { id: 'd2', name: 'Ana Driver' }] : k === 'assets' ? [{ id: 't1', name: 'Truck 12', booked: true }, { id: 't7', name: 'Truck 7', booked: true }] : [{ id: 'w1', name: 'Cara Diaz', phone: '+15555550102' }]); }
    if (u.pathname === '/api/logistics-state') {
      if (req.method() === 'GET') return reply({ states: Object.values(states), serverTime: new Date().toISOString() });
      const b = req.postDataJSON(); const cur = states[b.moveId];
      const { data } = mutateMove({ data: cur }, b);
      states[b.moveId] = { ...data, moveId: b.moveId, version: cur.version + 1 };
      return reply({ ok: true, state: states[b.moveId] });
    }
    if (u.pathname === '/api/workflow-effect') { if (req.method() === 'POST') effects.push(req.postDataJSON()); return reply(req.method() === 'POST' ? { ok: true } : { issues: [] }); }
    return reply({});
  });
  await page.goto('https://a2z.test/');
  await page.click('#logisticsViewTab');
  await page.waitForSelector('tr[data-move-key="add1"] .logistics-loads-input');
  const saveLoads = async (key, n) => {
    await page.fill(`tr[data-move-key="${key}"] .logistics-loads-input`, String(n));
    await page.click(`tr[data-move-key="${key}"] .logistics-loads-save`);
    await page.waitForFunction(n => new RegExp(`${n} loads? saved`).test(document.getElementById('toast').innerText), n);
    await page.waitForTimeout(300);
  };
  await saveLoads('add1', 3);
  await saveLoads('add2', 2);
  assert.equal(states.add1.truckLoads, 3); assert.equal(states.add1.truckLoadsDate, today);
  assert.equal(effects.filter(e => e.payload.action === 'loadCount').length, 0, 'add-ons on contract jobs do not post loadCount');
  await saveLoads('box1', 4);
  const lc = effects.find(e => e.payload.action === 'loadCount');
  assert.equal(lc.kind, 'driver_log'); assert.equal(lc.payload.loadCount, 4); assert.equal(lc.payload.moveId, 'box1'); assert.equal(lc.payload.date, today);
  assert.equal(lc.payload.vehicles, 'Truck 7'); assert.equal(lc.payload.driverName, 'Ana Driver'); assert.equal(lc.payload.containerSize, '30 Yard');
  assert.equal(await page.inputValue('tr[data-move-key="box1"] .logistics-loads-input'), '4');
  // Reset Day on the container: jobLog to the same webhook, with the day's loads; next day starts blank.
  await page.click('tr[data-move-key="box1"] .logistics-action[data-action="reset"]');
  await page.waitForFunction(() => /day reset/.test(document.getElementById('toast').innerText));
  const jl = effects.find(e => e.payload.action === 'jobLog');
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('tr[data-move-key="box1"] .logistics-loads-input'), '', 'after Reset Day the loads box starts blank');
  assert.equal(jl.kind, 'driver_log'); assert.equal(jl.payload.loadCount, 4); assert.equal(jl.payload.employee, 'Ana Driver'); assert.ok(Array.isArray(jl.payload.rows));
  // EOD on the contract job picks up 3 + 2 loads.
  await page.click('#laborViewTab');
  await page.click('.job-stage-btn.reset[data-job-id="demoJob1"]');
  await page.waitForFunction(() => !document.getElementById('eodLoadsNote').hidden);
  assert.match(await page.locator('#eodLoadsNote').innerText(), /Truck loads from Logistics: 5 \(3 on Truck 12, 2 on a truck\)\. Filled into Interior Hauling at \$375 a load/);
  const hauling = page.locator('.eod-section[data-section="interior"] .eod-line[data-category="Hauling"]');
  assert.equal(await hauling.locator('.eod-desc').inputValue(), 'Full Truck Load (excludes dump fees)');
  assert.equal(await hauling.locator('.eod-qty').inputValue(), '5'); assert.equal(await hauling.locator('.eod-rate').inputValue(), '375');
  assert.match(await page.locator('#eodTotalCost').innerText(), /\$1,875\.00/);
  await page.click('#submitEodSheet');
  await page.waitForFunction(() => /EOD sheet sent/.test(document.getElementById('toast').innerText));
  const eod = effects.find(e => e.kind === 'eod_sheet').payload;
  assert.equal(eod.truckLoads, 5); assert.equal(eod.truckLoadMoves.length, 2);
  assert.equal(eod.INTERIOR_HAULING_QTY, 5);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('Truck loads smoke passed.', JSON.stringify(lc.payload));
})().catch(e => { console.error(e); process.exit(1); });
