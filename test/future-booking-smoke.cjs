// Optional browser QA: a worker booked on today's job can still be scheduled for a
// job on another day (no Split day needed). Same day still needs Split day.
// PW_EXEC can point at a local Chromium.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PW_EXEC ? { executablePath: process.env.PW_EXEC } : {}) }); const context = await browser.newContext();
  const effects = [], crewTexts = [], commits = [], errors = [];
  const today = ymd(new Date()), later = ymd(new Date(Date.now() + 7 * 864e5));
  const t = d => ({ reportDate: d, reportTime: '07:00', reportEndDate: d, reportEndTime: '15:30' });
  const state = {
    today1: { jobId: 'today1', version: 1, active: true, crew: [{ id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }], ...t(today) },
    today2: { jobId: 'today2', version: 1, active: true, crew: [], ...t(today) },
    later1: { jobId: 'later1', version: 1, active: true, crew: [{ id: 'w2', name: 'Bob Ray', phone: '+15555550101' }], ...t(later) },
    later2: { jobId: 'later2', version: 1, active: true, crew: [], ...t(later) }
  };
  const roster = [{ id: 'w1', name: 'Ana Lopez', phone: '+15555550100' }, { id: 'w2', name: 'Bob Ray', phone: '+15555550101' }, { id: 'w3', name: 'Cara Diaz', phone: '+15555550102' }];
  const job = (id, name) => ({ id, name, sourceType: 'labor', contact: { name: 'Client' }, customFields: [] });
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()); const reply = j => route.fulfill({ json: j });
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply(req.method() === 'GET' ? { signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'picker' } : {});
    if (u.pathname === '/api/dashboard-data') return reply({ jobs: [job('today1', '1 Today St'), job('today2', '2 Today St'), job('later1', '1 Later Ave'), job('later2', '2 Later Ave')], sharedState: Object.values(state) });
    if (u.pathname === '/api/roster') return reply(u.searchParams.get('kind') === 'labor' ? roster : []);
    if (u.pathname === '/api/shared-state') {
      if (req.method() === 'GET') return reply({ sharedState: Object.values(state), pendingSync: [] });
      const b = req.postDataJSON(); commits.push(b); const rec = state[b.jobId];
      if (b.action === 'assign') state[b.jobId] = { ...rec, crew: [...rec.crew, ...b.crewChanges.map(w => ({ id: w.contactId, name: w.workerName, phone: w.workerPhone }))], version: rec.version + 1 };
      return reply({ ok: true, record: state[b.jobId] });
    }
    if (u.pathname === '/api/workflow-effect') { if (req.method() === 'POST') { const e = req.postDataJSON(); if (e.payload?.action === 'crewText') crewTexts.push(e); else effects.push(e); } return reply(req.method() === 'POST' ? { ok: true } : { issues: [] }); }
    if (u.pathname === '/api/manual-workers') return reply({ workers: [], hidden: [] });
    return reply({});
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => document.getElementById('jobsBody').innerText.includes('2 Later Ave'));
  const visible = W => page.evaluate(W => [...document.querySelectorAll(W + ' .crew-assign-option')].filter(o => getComputedStyle(o).display !== 'none').map(o => o.querySelector('.crew-worker-select').dataset.name), W);
  const badge = (W, n) => page.evaluate(([W, n]) => [...document.querySelectorAll(W + ' .crew-assign-option')].find(o => o.querySelector('.crew-worker-select').dataset.name === n)?.querySelector('.crew-booked-badge')?.textContent || '', [W, n]);

  // Roster / Booked Today: Ana is on today's job, Bob only on next week's.
  assert.equal(await page.textContent('#statBooked'), '1', 'only Ana is booked today');
  assert.equal(await page.textContent('#statAvailable'), '2');

  // Same day as Ana's job: she still needs Split day.
  const T2 = '.crew-assign-wrap[data-job-id="today2"]';
  await page.click(T2 + ' .crew-assign-toggle');
  assert.deepEqual(await visible(T2), ['Bob Ray', 'Cara Diaz'], 'Ana hidden on her booked day');
  assert.match(await badge(T2, 'Bob Ray'), /^also /, 'Bob shows his other day');
  await page.click(T2 + ' .crew-assign-toggle');

  // Next week: Ana is free and can be scheduled with a normal assignment.
  const L2 = '.crew-assign-wrap[data-job-id="later2"]';
  await page.click(L2 + ' .crew-assign-toggle');
  assert.deepEqual(await visible(L2), ['Ana Lopez', 'Cara Diaz'], 'Ana free next week, Bob booked that day');
  assert.match(await badge(L2, 'Ana Lopez'), /^also /);
  assert.equal(await badge(L2, 'Bob Ray'), 'booked this day');
  await page.evaluate(L2 => { const cb = [...document.querySelectorAll(L2 + ' .crew-worker-select')].find(c => c.dataset.name === 'Ana Lopez'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }, L2);
  await page.evaluate(L2 => document.querySelector(L2 + ' .crew-assign-confirm').click(), L2);
  await page.waitForTimeout(900);
  assert.deepEqual(commits.map(c => c.jobId), ['later2']);
  assert.equal(effects.length, 1); assert.equal(effects[0].kind, 'workers'); assert.equal(effects[0].payload.action, 'assign');
  assert.equal(effects[0].payload.workerReportDate, later);
  assert.equal(await page.textContent('#statBooked'), '1', 'still only booked today once');
  assert.deepEqual(errors, []);
  await browser.close(); console.log('future booking smoke ok');
})().catch(e => { console.error(e); process.exit(1); });
