// Optional browser QA: Completed holds its Make sends on the server for the undo window.
// node test/undo-close-smoke.cjs  (set PLAYWRIGHT_MODULE if playwright is not installed locally)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {
  const { mutateJob, checkVersion } = await import(pathToFileURL(path.resolve(__dirname, '../lib/state.mjs')));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const effects = [], commits = [], errors = []; const held = new Map();
  const crew = [{ id: 'w1', name: 'Aldo Reyes', phone: '+13105551111' }, { id: 'w2', name: 'Jose Gutierrez', phone: '+13105552222' }];
  let job = { jobId: 'job00000001', version: 1, active: true, crew, scopeOfWork: 'Demo', reportDate: '2026-10-07', reportTime: '08:00', reportEndDate: '2026-10-07', reportEndTime: '17:00' };
  const jobs = [{ id: 'job00000001', name: '55 Harbor Blvd', sourceType: 'labor', contact: { name: 'Kim', phone: '+12135550000' }, customFields: [] }];
  let n = 0; const fresh = () => ({ ...JSON.parse(JSON.stringify(job)) });
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/blank') return route.fulfill({ contentType: 'text/html', body: '<p>bye</p>' });
    if (u.pathname === '/api/session') return reply({ ok: true, signedIn: true, token: 't', user: { id: 'u1', name: 'Jesse Pickar', email: 'jesse@a2zcs.net' }, isAdmin: true });
    if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: [fresh()] });
    if (u.pathname === '/api/roster') return reply(u.searchParams.get('kind') ? [] : crew);
    if (u.pathname === '/api/workflow-effect') {
      if (req.method() !== 'POST') return reply({ issues: [] });
      const b = req.postDataJSON();
      if (b.op === 'cancel') { const cancelled = b.effectIds.filter(id => held.get(id)?.status === 'scheduled'); cancelled.forEach(id => { held.get(id).status = 'cancelled'; }); return reply({ ok: true, cancelled, tooLate: b.effectIds.filter(id => !cancelled.includes(id)) }); }
      if (b.op === 'send') { const sent = b.effectIds.filter(id => held.get(id)?.status === 'scheduled'); sent.forEach(id => { held.get(id).status = 'confirmed'; effects.push(held.get(id).body); }); return reply({ ok: true, claimed: sent, sent, failed: [] }); }
      if (b.delayMs > 0) { const effectId = `${b.requestId}:${b.kind}`; if (!held.has(effectId)) held.set(effectId, { status: 'scheduled', body: b }); return reply({ ok: true, scheduled: true, effectId }); }
      effects.push(b); return reply({ ok: true });
    }
    if (u.pathname === '/api/shared-state') {
      if (req.method() === 'GET') return reply({ sharedState: [fresh()], pendingSync: [] });
      const b = req.postDataJSON(); commits.push(b.action);
      try { checkVersion(job, b); const next = mutateJob({ version: job.version, active: job.active, data: job }, b); job = { ...next.data, active: next.active, jobId: job.jobId, version: job.version + 1 }; return reply({ ok: true, record: fresh(), requestId: b.requestId }); }
      catch (e) { return reply({ error: e.message }, e.status || 400); }
    }
    return reply({});
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto('https://a2z.test/');
  await page.waitForSelector('.job-stage-btn.complete');
  page.setDefaultTimeout(8000);
  // Completed / Cancelled need a 5 second hold.
  const hold = async (sel, ms = 5200) => { const box = await page.locator(sel).first().boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(ms); await page.mouse.up(); };
  await page.click('.job-stage-btn.complete'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.close-undo-bar').count(), 0, 'a quick click does nothing');
  await hold('.job-stage-btn.complete', 2000);
  assert.equal(await page.locator('.close-undo-bar').count(), 0, 'letting go early does nothing');
  // 1. Completed, then Undo: job back with its crew, nothing sent.
  await hold('.job-stage-btn.complete');
  await page.waitForSelector('.close-undo-bar');
  assert.equal(job.status, 'completed'); assert.equal(job.crew.length, 0);
  await page.waitForTimeout(1500); assert.equal(effects.length, 0, 'nothing sent during the undo window');
  await page.click('.close-undo-btn'); await page.waitForTimeout(800);
  assert.equal(job.active, true); assert.deepEqual(job.crew.map(w => w.name), ['Aldo Reyes', 'Jose Gutierrez']);
  assert.equal(effects.length, 0); assert.deepEqual(commits, ['complete', 'reopen', 'assign']);
  // 2. Completed, then Send now: stage + job log go out with the crew.
  await hold('.job-stage-btn.complete'); await page.waitForSelector('.close-send-btn');
  await page.click('.close-send-btn'); await page.waitForTimeout(800);
  assert.deepEqual(effects.map(e => e.kind), ['job_stage', 'job_log']);
  assert.equal(effects[1].payload.assignedWorkers.length, 2);
  assert.equal([...held.values()].filter(h => h.status === 'cancelled').length, 2, 'Undo cancelled both held sends');
  // 3. Reopen + crew back, Completed, then leave the page: keepalive sends on pagehide.
  await page.evaluate(async () => { await commitState(CONFIG.SHARED_STATE_SYNC_URL, { action: 'reopen', jobId: 'job00000001' }); render(); });
  effects.length = 0;
  await page.waitForSelector('.job-stage-btn.complete'); await hold('.job-stage-btn.complete'); await page.waitForSelector('.close-undo-bar');
  // Fire the tab closing event in place (a real unload's keepalive request escapes the test's network mock).
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide'))); await page.waitForTimeout(800);
  assert.deepEqual(effects.map(e => e.kind).sort(), ['job_log', 'job_stage'], 'sends on tab close');
  assert.ok(effects.every(e => e.delayMs === 30000), 'held for 30 seconds');
  // 4. Browser dies mid window (no pagehide): the sends stay held on the server, not cancelled, so its sweep sends them.
  await page.evaluate(async () => { await commitState(CONFIG.SHARED_STATE_SYNC_URL, { action: 'reopen', jobId: 'job00000001' }); render(); });
  await page.waitForSelector('.job-stage-btn.complete'); await hold('.job-stage-btn.complete'); await page.waitForSelector('.close-undo-bar');
  const before = effects.length;
  // Nothing more from the browser; the server already holds both sends (its sweep is covered in database.test.mjs).
  assert.equal([...held.values()].filter(h => h.status === 'scheduled').length, 2, 'held sends live on the server');
  assert.equal(effects.length, before);
  assert.deepEqual(errors, []);
  console.log('Undo close smoke passed.');
  await browser.close();
})().catch(e => { console.error(e); process.exitCode = 1; });
