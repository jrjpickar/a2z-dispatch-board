// Optional browser QA: EOD crew hours (default = day's hours minus 1 h lunch, editable,
// sent home value carried in), no markup, one job_hours run per worker, and the
// password gate outside GHL.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {
  const { mutateJob, checkVersion } = await import(pathToFileURL(path.resolve(__dirname, '../lib/state.mjs')));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const errors = [], effects = [], sessionPosts = []; let ghlUsersCalls = 0;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const jobs = [{ id: 'job00000001', name: '55 Elm St', sourceType: 'labor', contact: { id: 'c1', name: 'Client' }, customFields: [] }];
  const roster = [{ id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }, { id: 'w2', name: 'Bob Ray', phone: '+15555550101' }, { id: 'w3', name: 'Cara Diaz', phone: '+15555550102' }];
  let rec = { jobId: 'job00000001', version: 1, active: true, crew: roster.slice(), reportDate: day, reportTime: '07:00', reportEndDate: day, reportEndTime: '15:30' };
  const setup = async (page, signedIn) => {
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url());
      if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
      const reply = json => route.fulfill({ json });
      if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
      if (u.pathname === '/api/session') {
        if (req.method() === 'GET') return reply(signedIn ? { signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'user_id' } : { signedIn: false });
        const b = req.postDataJSON(); sessionPosts.push(b);
        if (b.action === 'signin' && b.userId !== 'uSam12345') return route.fulfill({ status: 401, json: { error: 'That GHL user ID is not right.' } });
        return reply({ ok: true, token: 't', signedIn: true, user: { id: b.userId, name: 'Sam', email: 's@x' }, via: 'user_id' });
      }
      if (u.pathname === '/api/ghl-users') { ghlUsersCalls++; return reply({ users: [{ id: 'uSam12345', name: 'Sam', email: 's@x' }] }); }
      if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: [rec] });
      if (u.pathname === '/api/roster') return reply(u.searchParams.get('kind') === 'labor' ? roster : []);
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
  };

  // 1. Password gate: not signed in outside GHL -> blocking sign-in, the GHL user ID is the password.
  const gate = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await setup(gate, false);
  await gate.waitForFunction(() => !document.getElementById('signinBackdrop').hidden);
  assert.equal(await gate.locator('#signinUser').count(), 0, 'no name list on the sign-in page');
  assert.equal(ghlUsersCalls, 0, 'the user list (with IDs) is never loaded before sign-in');
  await gate.click('#signinSubmit');
  assert.match(await gate.locator('#signinError').innerText(), /GHL user ID/);
  await gate.fill('#signinPassword', 'Sam');
  await gate.click('#signinSubmit');
  await gate.waitForFunction(() => /not right/.test(document.getElementById('signinError').innerText));
  assert.equal(await gate.locator('#signinBackdrop').isVisible(), true);
  await gate.fill('#signinPassword', ' uSam12345 ');
  await gate.press('#signinPassword', 'Enter');
  await gate.waitForFunction(() => document.getElementById('signinBackdrop').hidden);
  const signin = sessionPosts.filter(b => b.action === 'signin').pop();
  assert.equal(signin.userId, 'uSam12345'); assert.equal(signin.source, 'user_id');
  assert.equal(await gate.locator('#signinIdBtn').isVisible(), true);
  await gate.close();

  // 2. Send Ana home with 4 hours, then open the EOD sheet.
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await setup(page, true);
  await page.waitForFunction(() => document.getElementById('jobsBody').innerText.includes('Ana Lopez'));
  await page.locator('#sentHomeBtn').click();
  await page.locator('#sentHomeWorkers label', { hasText: 'Ana Lopez' }).click();
  await page.selectOption('#sentHomeHours', '4');
  await page.locator('#sentHomeConfirm').click();
  await page.waitForFunction(() => document.getElementById('toast').innerText.includes('sent home'));
  await page.waitForTimeout(300);
  await page.locator('.job-stage-btn.reset[data-job-id="job00000001"]').click();
  await page.waitForSelector('#eodSheet.open');
  assert.equal(await page.locator('#eodMarkup').count(), 0, 'markup section is gone');
  assert.doesNotMatch(await page.locator('#eodSheet').innerText(), /markup|price to customer/i);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#eodCrewRows .eod-crew-row')].map(r => [r.querySelector('.eod-crew-name').textContent.replace(/\s+/g, ' ').trim(), r.querySelector('.eod-hours').value]));
  // 07:00 to 15:30 is 8.5 h, minus 1 h lunch = 7.5.
  assert.deepEqual(await rows(), [['Bob Ray', '7.5'], ['Cara Diaz', '7.5'], ['Ana Lopez sent home', '4']]);
  assert.doesNotMatch(await page.locator('#eodCrewSection').innerText(), /\$|rate/i, 'no pay rates in crew hours');
  assert.equal(await page.locator('#eodCrewTotal').innerText(), '19');
  const hours = page.locator('#eodCrewRows .eod-crew-row').nth(0).locator('.eod-hours');
  await hours.fill('6.25');
  assert.equal(await page.locator('#eodCrewTotal').innerText(), '17.75');
  // Draft keeps the edit across close and reopen.
  await page.click('#cancelEodSheet');
  await page.locator('.job-stage-btn.reset[data-job-id="job00000001"]').click();
  assert.deepEqual((await rows()).map(r => r[1]), ['6.25', '7.5', '4']);
  const line = page.locator('.eod-section[data-section="interior"] .eod-line').first();
  await line.locator('.eod-desc').fill('Skilled Labor');
  await line.locator('.eod-qty').fill('17.75');
  await line.locator('.eod-rate').fill('65');
  await page.locator('#eodCrewSection').scrollIntoViewIfNeeded();
  await page.screenshot({ path: process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, 'eod-hours.png') : '/dev/null', fullPage: false }).catch(() => {});
  await page.click('#submitEodSheet');
  await page.waitForFunction(() => document.getElementById('toast').innerText.includes('EOD sheet sent'));
  await page.waitForTimeout(500);
  const eod = effects.find(e => e.kind === 'eod_sheet').payload;
  assert.ok(!('markupPercent' in eod) && !('MARKUP_PERCENT' in eod) && !('totalPriceToCustomer' in eod));
  assert.deepEqual(eod.crewHours.map(w => [w.workerName, w.hoursWorked, w.sentHome]), [['Bob Ray', 6.25, false], ['Cara Diaz', 7.5, false], ['Ana Lopez', 4, true]]);
  assert.equal(eod.totalCrewHours, 17.75); assert.equal(eod.CREW_3_NAME, 'Ana Lopez'); assert.equal(eod.CREW_3_HOURS, 4);
  const hoursRuns = effects.filter(e => e.kind === 'job_hours');
  assert.equal(hoursRuns.length, 3, 'one job hours run per worker');
  assert.equal(new Set(hoursRuns.map(e => e.effectKey)).size, 3);
  const bob = hoursRuns.find(e => e.payload.employeeName === 'Bob Ray').payload;
  assert.equal(bob.date, day); assert.equal(bob.hoursWorked, 6.25); assert.equal(bob.notes, 'Client - 55 Elm St'); assert.equal(bob.action, 'job_hours');
  assert.equal(bob.dayOfWeek, new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }));
  assert.ok(effects.some(e => e.kind === 'job_log'));
  assert.deepEqual(rec.crew, [], 'day reset');
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('EOD hours + password gate smoke passed.', JSON.stringify(bob));
})().catch(e => { console.error(e); process.exit(1); });
