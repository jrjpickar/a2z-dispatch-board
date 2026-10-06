// Optional browser QA for change orders: supply PLAYWRIGHT_MODULE and CHROME_EXECUTABLE if not installed locally.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {
  const { mutateJob, checkVersion } = await import(pathToFileURL(path.resolve(__dirname, '../lib/state.mjs')));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  const jobs = [
    { id: 'parent0001', name: '100 Main St', sourceType: 'demo', pipelineStageId: 'bb901617-1ec6-4f3c-8c77-27ccafb96404', contact: { id: 'c1', name: 'Acme Builders' }, customFields: [], monetaryValue: 20000 },
    { id: 'other00002', name: '9 Oak Ave', sourceType: 'labor', contact: { id: 'c2', name: 'Other Co' }, customFields: [] },
    { id: 'co00000003', name: '100 Main St extra wall', sourceType: 'labor', contact: { id: 'c1', name: 'Acme Builders' }, customFields: [], monetaryValue: 3500 }
  ];
  const state = new Map();
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    const reply = json => route.fulfill({ json });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: [...state.values()] });
    if (u.pathname === '/api/session') return reply(req.method() === 'GET' ? { signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'picker' } : {});
    if (u.pathname === '/api/roster') return reply([]);
    if (u.pathname === '/api/logistics-data') return reply({ moves: [] });
    if (u.pathname === '/api/workflow-effect') return reply(req.method() === 'POST' ? { ok: true } : { issues: [] });
    if (u.pathname === '/api/shared-state') {
      if (req.method() === 'GET') return reply({ sharedState: [...state.values()], pendingSync: [] });
      const payload = req.postDataJSON(); posts.push(payload);
      const cur = state.get(payload.jobId);
      try {
        checkVersion(cur && { version: cur.version }, payload);
        const next = mutateJob(cur && { version: cur.version, active: cur.active, data: cur }, payload);
        const record = { ...next.data, jobId: payload.jobId, active: next.active, version: (cur?.version || 0) + 1 };
        state.set(payload.jobId, record);
        let ghlMove;
        if (payload.action === 'link_change_order') { const j = jobs.find(x => x.id === payload.jobId); ghlMove = { status: j.sourceType === 'change_order' ? 'already' : 'moved' }; j.sourceType = 'change_order'; }
        return reply({ ok: true, record, ghlMove });
      } catch (error) { return route.fulfill({ status: error.status || 400, json: { error: error.message } }); }
    }
    return reply({});
  });
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => document.getElementById('jobsBody').innerText.includes('100 Main St extra wall'));
  // Open Edit Details on the change order and link it.
  await page.locator('.job-stage-btn.edit[data-job-id="co00000003"]').click();
  await page.locator('#editLinkChangeOrderBtn').click();
  const groups = await page.locator('#editChangeOrderList .co-picker-group').allInnerTexts();
  assert.equal(groups[0].toLowerCase(), 'same client');
  assert.equal(await page.locator('#editChangeOrderList [data-parent-id="co00000003"]').count(), 0, 'a job is never offered as its own parent');
  assert.match(await page.locator('#editChangeOrderHint').innerText(), /moves this job to the Change Order pipeline/);
  await page.locator('#editChangeOrderList [data-parent-id="parent0001"]').click();
  await page.screenshot({ path: process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, 'co-picker.png') : '/dev/null' }).catch(() => {});
  await page.locator('#editChangeOrderConfirm').click();
  await page.waitForFunction(() => document.getElementById('toast').innerText.includes('moved to the Change Order pipeline'));
  const link = posts.find(p => p.action === 'link_change_order');
  assert.equal(link.parentJobId, 'parent0001'); assert.equal(link.parentJobName, '100 Main St');
  await page.waitForFunction(() => /Change order for 100 Main St/.test(document.getElementById('editChangeOrderCurrent').innerText));
  // Editing other details after linking must not hit a version conflict.
  await page.locator('#editScopeWork').fill('Extra wall');
  await page.locator('#submitEditJob').click();
  await page.waitForFunction(() => !document.getElementById('editJobSheet').classList.contains('open'));
  assert.equal(state.get('co00000003').parentJobId, 'parent0001');
  assert.equal(state.get('co00000003').scopeOfWork, 'Extra wall');
  // Parent row shows the note; change order row shows "for 100 Main St".
  const parentRow = page.locator('tr[data-job-row="parent0001"]');
  assert.match(await parentRow.locator('.co-note').innerText(), /1 change order[\s\S]*100 Main St extra wall[\s\S]*\$3,500/i);
  assert.match(await page.locator('tr[data-job-row="co00000003"] .co-parent-note').innerText(), /for 100 Main St/);
  await page.screenshot({ path: process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, 'co-board.png') : '/dev/null', fullPage: true }).catch(() => {});
  // The parent can't be linked as a change order itself.
  await page.locator('.job-stage-btn.edit[data-job-id="parent0001"]').click();
  assert.equal(await page.locator('#editLinkChangeOrderBtn').isDisabled(), true);
  await page.locator('#cancelEditJob').click();
  // Unlink.
  await page.locator('.job-stage-btn.edit[data-job-id="co00000003"]').click();
  await page.locator('#editUnlinkChangeOrderBtn').click();
  await page.waitForFunction(() => document.getElementById('toast').innerText.includes('Unlinked'));
  assert.equal(state.get('co00000003').parentJobId, undefined);
  await page.locator('#cancelEditJob').click();
  assert.equal(await page.locator('tr[data-job-row="parent0001"] .co-note').count(), 0);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('Change order smoke passed.');
})().catch(e => { console.error(e); process.exit(1); });
