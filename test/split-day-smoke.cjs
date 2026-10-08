// Optional browser QA: Split day = one worker on two jobs with one Make run (split_day webhook),
// plus custom per worker times. PW_EXEC can point at a local Chromium.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); const fs = require('fs'), path = require('path'), assert = require('assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_EXEC ? { executablePath: process.env.PW_EXEC } : {}) }); const context = await browser.newContext();
  const effects = []; const commits = []; const errors = [];
  const times = { reportDate: '2026-10-09', reportTime: '07:00', reportEndDate: '2026-10-09', reportEndTime: '15:30' };
  const state = {
    job1: { jobId: 'job1', version: 1, active: true, crew: [], ...times },
    job2: { jobId: 'job2', version: 1, active: true, crew: [{ id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }], ...times, reportTime: '06:00', reportEndTime: '11:00' }
  };
  const roster = [{ id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }, { id: 'w2', name: 'Bob Ray', phone: '+15555550101' }, { id: 'w3', name: 'Cara Diaz', phone: '+15555550102' }];
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()); const reply = j => route.fulfill({ json: j });
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply(req.method() === 'GET' ? { signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'picker' } : {});
    if (u.pathname === '/api/dashboard-data') return reply({ jobs: [{ id: 'job1', name: '12 Main St', sourceType: 'labor', contact: { name: 'Client' }, customFields: [] }, { id: 'job2', name: '99 Oak Ave', sourceType: 'labor', contact: { name: 'Other' }, customFields: [] }], sharedState: Object.values(state) });
    if (u.pathname === '/api/roster') return reply(u.searchParams.get('kind') === 'labor' ? roster : []);
    if (u.pathname === '/api/shared-state') {
      if (req.method() === 'GET') return reply({ sharedState: Object.values(state), pendingSync: [] });
      const b = req.postDataJSON(); commits.push(b);
      const rec = state[b.jobId];
      if (b.action === 'assign') state[b.jobId] = { ...rec, crew: [...rec.crew, ...b.crewChanges.map(w => ({ id: w.contactId, name: w.workerName, phone: w.workerPhone }))], version: rec.version + 1 };
      return reply({ ok: true, record: state[b.jobId] });
    }
    if (u.pathname === '/api/workflow-effect') { if (req.method() === 'POST') effects.push(req.postDataJSON()); return reply(req.method() === 'POST' ? { ok: true } : { issues: [] }); }
    if (u.pathname === '/api/manual-workers') return reply({ workers: [], hidden: [] });
    return reply({});
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => document.getElementById('jobsBody').innerText.includes('12 Main St'));
  const W = '.crew-assign-wrap[data-job-id="job1"]';
  const tick = names => page.evaluate(([W, names]) => { for (const n of names) { const cb = [...document.querySelectorAll(W + ' .crew-worker-select')].find(c => c.dataset.name === n); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); } }, [W, names]);
  const setField = (name, field, value) => page.evaluate(([W, name, field, value]) => { const el = document.querySelector(`${W} .crew-split-picks [data-worker="${name}"][data-field="${field}"]`); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, [W, name, field, value]);
  const disabled = () => page.evaluate(W => document.querySelector(W + ' .crew-assign-confirm').disabled, W);

  // 1. Split day: Ana (already on job2) and Bob (on nothing yet) both go to job1 + job2.
  await page.click(W + ' .crew-assign-toggle');
  await page.click(W + ' .split-day-control');
  await tick(['Ana Lopez', 'Bob Ray']);
  assert.equal(await disabled(), true, 'needs the other job first');
  const bobOptions = await page.evaluate(W => [...document.querySelectorAll(`${W} .crew-split-picks select[data-worker="Bob Ray"] option`)].map(o => o.value).join(','), W);
  assert.equal(bobOptions, ',job2', 'unassigned worker can pick any scheduled job');
  await setField('Ana Lopez', 'otherJobId', 'job2');
  await setField('Bob Ray', 'otherJobId', 'job2');
  assert.equal(await page.evaluate(W => document.querySelector(`${W} [data-worker="Bob Ray"][data-field="otherStart"]`).value, W), '06:00', 'other job times prefilled');
  await setField('Bob Ray', 'end', '11:00');
  await setField('Bob Ray', 'otherStart', '11:30');
  await setField('Bob Ray', 'otherEnd', '15:30');
  assert.equal(await disabled(), false);
  // Search narrows the list but ticked workers stay.
  await page.evaluate(W => { const s = document.querySelector(W + ' .crew-assign-search'); s.value = 'zzz'; s.dispatchEvent(new Event('input', { bubbles: true })); }, W);
  assert.equal(await page.evaluate(W => document.querySelectorAll(W + ' .crew-assign-option:not(.search-hidden)').length, W), 2);
  await page.evaluate(W => document.querySelector(W + ' .crew-assign-confirm').click(), W);
  await page.waitForTimeout(900);
  assert.deepEqual(commits.map(c => c.jobId), ['job1', 'job2'], 'job1 then the other job');
  assert.deepEqual(commits[1].crewChanges.map(w => w.workerName), ['Bob Ray'], 'Ana was already on job2');
  assert.equal(effects.length, 2); assert.ok(effects.every(e => e.kind === 'split_day'), 'one split run per worker, no worker webhook run');
  const bob = effects.find(e => e.payload.workerName === 'Bob Ray').payload, ana = effects.find(e => e.payload.workerName === 'Ana Lopez').payload;
  assert.equal(bob.action, 'split_day_assign'); assert.equal(bob.addedToJob2, true); assert.equal(ana.addedToJob2, false);
  assert.equal(bob.jobId1, 'job1'); assert.equal(bob.jobId2, 'job2'); assert.equal(bob.jobAddress1, '12 Main St'); assert.equal(bob.jobAddress2, '99 Oak Ave'); assert.equal(bob.jobCount, 2);
  assert.ok(!Object.values(bob).some((v, i) => Array.isArray(v) && Object.keys(bob)[i] !== 'assignedWorkers'), 'no arrays besides assignedWorkers'); assert.ok(!('otherJob' in bob) && !('splitJobs' in bob));
  assert.equal(bob.workerReportTime, '07:00'); assert.equal(bob.workerReportEndTime, '11:00'); assert.equal(bob.customTime, true);
  assert.equal(bob.workerReportTime1, '07:00'); assert.equal(bob.workerReportEndTime1, '11:00'); assert.equal(bob.workerReportTime2, '11:30'); assert.equal(bob.workerReportEndTime2, '15:30'); assert.equal(bob.reportTime2, '06:00');
  assert.equal(bob.reportTime, '07:00'); assert.equal(bob.reportEndTime, '15:30', 'job times unchanged');
  assert.equal(ana.workerReportTime, '07:00'); assert.equal(ana.customTime, false); assert.equal(ana.workerReportTime2, '06:00'); assert.equal(ana.customTime2, false);

  // 2. Normal assignment with custom times for one worker (worker webhook).
  await page.waitForSelector(W + ' .crew-assign-toggle');
  await page.click(W + ' .crew-assign-toggle');
  await tick(['Cara Diaz']);
  await page.click(W + ' .crew-custom-time-toggle');
  await setField('Cara Diaz', 'start', '09:00');
  await setField('Cara Diaz', 'end', '12:00');
  await page.evaluate(W => document.querySelector(W + ' .crew-assign-confirm').click(), W);
  await page.waitForTimeout(900);
  const cara = effects.find(e => e.payload.workerName === 'Cara Diaz');
  assert.equal(cara.kind, 'workers'); assert.equal(cara.payload.action, 'assign');
  assert.equal(cara.payload.workerReportTime, '09:00'); assert.equal(cara.payload.workerReportEndTime, '12:00'); assert.equal(cara.payload.customTime, true);
  assert.equal(cara.payload.reportTime, '07:00');
  assert.deepEqual(errors, []);
  console.log('split day OK', JSON.stringify({ commits: commits.map(c => c.jobId), kinds: effects.map(e => e.kind), bob: [bob.jobAddress1, bob.workerReportTime1, bob.workerReportEndTime1, bob.jobAddress2, bob.workerReportTime2, bob.workerReportEndTime2] }));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
