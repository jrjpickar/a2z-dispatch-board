// Browser QA for profile types: a Viewer sees the board with every change/send control
// hidden and no write leaving the browser; a Blocked person gets the sign-in screen with
// the blocked message; a senior admin can set types in People and profile types.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
const jobs = [1, 2].map(i => ({ id: 'job' + i, name: i + ' Main St', sourceType: 'labor', contact: { name: 'Client ' + i }, customFields: [] }));
async function open(sessionInfo, extra = () => null) {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  const writes = [], errors = [];
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (req.method() !== 'GET' && u.pathname !== '/api/session') writes.push(u.pathname + ' ' + (req.postData() || ''));
    const hit = extra(u, req, reply); if (hit) return hit;
    if (u.pathname === '/api/session') return reply(sessionInfo);
    if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: [], serverTime: '2026-11-04T18:00:00.000Z' });
    if (u.pathname === '/api/roster') return reply([{ id: 'w1', name: 'Worker One', phone: '+15555550100' }]);
    if (u.pathname === '/api/shared-state') return reply({ sharedState: [], pendingSync: [], serverTime: '2026-11-04T18:00:01.000Z' });
    if (u.pathname === '/api/workflow-effect') return reply({ issues: [] });
    return reply({});
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://a2z.test/');
  return { browser, page, writes, errors };
}
(async () => {
  // Viewer
  {
    const { browser, page, writes, errors } = await open({ signedIn: true, token: 'tok-v', user: { id: 'uVic', name: 'Vic Viewer', email: 'v@a2zcs.net' }, via: 'user_id', profileType: 'viewer', isViewer: true });
    await page.waitForFunction(() => document.querySelectorAll('#jobsBody tr[data-job-row]').length === 2);
    assert.equal(await page.textContent('#whoamiRole'), 'VIEWER');
    assert.ok(await page.isVisible('.viewer-banner'));
    assert.equal(await page.isVisible('#newJobBtn'), false, 'Book Job hidden');
    assert.equal(await page.locator('#jobsBody .crew-assign-toggle:visible').count(), 0, 'Assign crew hidden');
    assert.equal(await page.locator('#jobsBody .job-stage-btn:visible').count(), 0, 'stage buttons hidden');
    await page.waitForTimeout(1500);
    assert.deepEqual(writes, [], 'a viewer sends nothing on load');
    const blocked = await page.evaluate(async () => { const r = await fetch('/api/shared-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return r.status; });
    assert.equal(blocked, 403);
    assert.deepEqual(writes, [], 'the blocked write never left the browser');
    assert.deepEqual(errors, []);
    await browser.close();
  }
  // Regular user: unchanged
  {
    const { browser, page, errors } = await open({ signedIn: true, token: 'tok-u', user: { id: 'uUma', name: 'Uma User', email: 'u@a2zcs.net' }, via: 'user_id', profileType: 'user', isViewer: false });
    await page.waitForFunction(() => document.querySelectorAll('#jobsBody tr[data-job-row]').length === 2);
    assert.equal(await page.textContent('#whoamiRole'), 'USER');
    assert.ok(await page.isVisible('#newJobBtn'));
    assert.equal(await page.isVisible('.viewer-banner'), false);
    assert.deepEqual(errors, []);
    await browser.close();
  }
  // Blocked
  {
    const { browser, page } = await open({ signedIn: false, user: null, blocked: true, error: 'Your access to the dispatch board is blocked. Ask a senior admin if this is a mistake.' });
    await page.waitForSelector('#signinBackdrop:not([hidden])');
    assert.match(await page.textContent('#signinError'), /blocked/);
    await browser.close();
  }
  // Senior admin sets a profile type
  {
    const posts = [];
    const users = [{ id: 'uJesse', name: 'Jesse Pickar', email: 'jesse@a2zcs.net' }, { id: 'uVic', name: 'Vic Viewer', email: 'v@a2zcs.net' }, { id: 'uUma', name: 'Uma User', email: 'u@a2zcs.net' }];
    let roles = [{ userId: 'uVic', role: 'viewer' }];
    const { browser, page, errors } = await open({ signedIn: true, token: 'tok-j', user: users[0], via: 'ghl_sso', isAdmin: true, isSenior: true, profileType: 'senior' }, (u, req, reply) => {
      if (u.pathname === '/api/ghl-users') return reply({ ok: true, users });
      if (u.pathname === '/api/admins') {
        if (req.method() === 'POST') { const b = req.postDataJSON(); posts.push(b); roles = [...roles.filter(r => r.userId !== b.userId), ...(b.role === 'user' ? [] : [{ userId: b.userId, role: b.role }])]; return reply({ ok: true, admins: [{ userId: 'uJesse', name: 'Jesse Pickar', addedBy: 'bootstrap' }], roles }); }
        return reply({ admins: [{ userId: 'uJesse', name: 'Jesse Pickar', addedBy: 'bootstrap' }], bootstrap: [], roles });
      }
      if (u.pathname === '/api/admin-dashboard') return reply({ layout: { panels: [{ id: 'people', w: 6, h: 0, hidden: false, audience: 'all' }] }, panels: [{ id: 'people', title: 'People' }], senior: true });
      return null;
    });
    await page.waitForFunction(() => !document.getElementById('adminViewTab').hidden);
    await page.click('#adminViewTab');
    await page.waitForSelector('#peopleList select[data-user-id="uUma"]');
    assert.equal(await page.textContent('#peopleCount'), '1 VIEWER');
    assert.equal(await page.inputValue('#peopleList select[data-user-id="uVic"]'), 'viewer');
    assert.equal(await page.locator('#peopleList select[data-user-id="uUma"] option[value="blocked"]').count(), 1, 'senior sees Blocked');
    page.once('dialog', d => d.accept());
    await page.selectOption('#peopleList select[data-user-id="uUma"]', 'blocked');
    await page.waitForFunction(() => document.getElementById('peopleCount').textContent.includes('1 BLOCKED'));
    assert.deepEqual(posts, [{ action: 'set_role', userId: 'uUma', role: 'blocked' }]);
    assert.deepEqual(errors, []);
    await browser.close();
  }
  console.log('profile types smoke: viewer read only, user unchanged, blocked refused, senior sets types');
})().catch(e => { console.error(e); process.exit(1); });
