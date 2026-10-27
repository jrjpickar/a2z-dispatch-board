// Optional browser QA: Assign selected also queues one crew_text effect (server builds, texts and logs it).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); const fs = require('fs'), path = require('path'), assert = require('assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true }); const context = await browser.newContext();
  const effects = []; const errors = [];
  const day = { reportDate: '2026-10-26', reportEndDate: '2026-10-26' };
  let states = {
    job1: { jobId: 'job1', version: 1, active: true, crew: [], ...day, reportTime: '07:00', reportEndTime: '15:30', jobType: 'contract', timesFirstLockedAt: 'x', projectConfiguredAt: 'x' },
    job2: { jobId: 'job2', version: 1, active: true, crew: [{ id: 'w3', name: 'Jose Fabian', phone: '+15555550102' }, { id: 'w1', name: 'Niko Reyes', phone: '+15555550100' }], ...day, reportTime: '07:00', reportEndTime: '15:30' },
    job3: { jobId: 'job3', version: 1, active: true, crew: [{ id: 'w4', name: 'Mario Danna', phone: '+15555550103' }], reportDate: '2026-10-26', reportEndDate: '2026-10-27', reportTime: '22:00', reportEndTime: '06:00', nightWork: true },
    job4: { jobId: 'job4', version: 1, active: true, crew: [{ id: 'w5', name: 'Other Day', phone: '+15555550104' }], reportDate: '2026-10-27', reportEndDate: '2026-10-27', reportTime: '07:00', reportEndTime: '15:30' }
  };
  const jobs = [
    { id: 'job1', name: '14851 Yorba St, Tustin', jobType: 'contract', contact: { name: 'NEW CASTLE CONSTRUCTION' }, customFields: [] },
    { id: 'job2', name: '16 Burning Tree Rd, Newport Beach', sourceType: 'labor', contact: { name: 'Jason' }, customFields: [] },
    { id: 'job3', name: '12681 Harbor Blvd', sourceType: 'labor', contact: { name: 'McGuire Builders' }, customFields: [] },
    { id: 'job4', name: '1 Other St', sourceType: 'labor', contact: { name: 'Tomorrow Co' }, customFields: [] }
  ];
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()); const reply = j => route.fulfill({ json: j });
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply(req.method() === 'GET' ? { signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'picker' } : {});
    if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: Object.values(states) });
    if (u.pathname === '/api/roster') return reply(u.searchParams.get('kind') === 'labor' ? [{ id: 'w1', name: 'Niko Reyes', phone: '+15555550100' }, { id: 'w2', name: 'Julio Herrera', phone: '+15555550101' }] : []);
    if (u.pathname === '/api/shared-state') {
      if (req.method() === 'GET') return reply({ sharedState: Object.values(states), pendingSync: [] });
      const b = req.postDataJSON(); const s = states[b.jobId];
      if (b.action === 'assign') states[b.jobId] = { ...s, crew: [...s.crew, ...b.crewChanges.map(w => ({ id: w.contactId, name: w.workerName, phone: w.workerPhone }))], version: s.version + 1 };
      return reply({ ok: true, record: states[b.jobId] });
    }
    if (u.pathname === '/api/workflow-effect') { if (req.method() === 'POST') effects.push(req.postDataJSON()); return reply(req.method() === 'POST' ? { ok: true } : { issues: [] }); }
    if (u.pathname === '/api/manual-workers') return reply({ workers: [], hidden: [] });
    return reply({});
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => document.body.innerText.includes('14851 Yorba'));
  // Call assignCrew directly for the contract job (the picker UI is covered by other smokes).
  await page.evaluate(async () => {
    const btn = document.createElement('button'); document.body.append(btn);
    await assignCrew('job1', [{ id: 'w1', name: 'Niko Reyes', phone: '+15555550100' }, { id: 'w2', name: 'Julio Herrera', phone: '+15555550101' }], btn);
  });
  await page.waitForTimeout(500);
  const perWorker = effects.filter(e => e.payload.action === 'assign');
  const crew = effects.filter(e => e.payload.action === 'crewText');
  assert.equal(perWorker.length, 2, 'per worker runs unchanged');
  assert.ok(perWorker.every(e => !('scheduleText' in e.payload)));
  assert.equal(crew.length, 1); assert.equal(crew[0].kind, 'crew_text', 'built and texted on the server, not Make');
  assert.deepEqual(Object.keys(crew[0].payload).sort(), ['action', 'jobAddress', 'jobId', 'rapidAssign', 'reportDate', 'reportTime', 'textWorkers', 'timeZone', 'triggeredBy']);
  assert.equal(crew[0].payload.reportDate, '2026-10-26');
  console.log('crewText OK', JSON.stringify(crew[0]));
  assert.deepEqual(errors, []);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
