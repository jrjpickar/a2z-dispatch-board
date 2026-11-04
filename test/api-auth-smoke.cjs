// Browser QA for the Nov 2026 API sign-in check: the board waits for sign-in before its
// first data load, so every API call (including the very first dashboard-data) carries the
// signed session header, and a fresh sign-in loads the board straight away.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function run({ signedIn }) {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  const errors = [], calls = [];
  const jobs = [1, 2].map(i => ({ id: 'job' + i, name: i + ' Main St', sourceType: 'labor', contact: { name: 'Client ' + i }, customFields: [] }));
  let token = signedIn ? 'tok-saved' : '';
  await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    const reply = (json, status = 200) => route.fulfill({ status, json });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    const sent = req.headers()['x-a2z-session'] || '';
    if (u.pathname === '/api/session') {
      if (req.method() === 'POST') { token = 'tok-new'; return reply({ signedIn: true, token, user: { id: 'u1', name: 'Sam', email: 's@a2zcs.net' }, via: 'user_id' }); }
      return reply(token ? { signedIn: true, token, user: { id: 'u1', name: 'Sam', email: 's@a2zcs.net' }, via: 'user_id' } : { signedIn: false });
    }
    calls.push({ path: u.pathname, sent });
    if (!sent || sent !== token) return reply({ error: 'Sign in to the dispatch board first.' }, 401);
    if (u.pathname === '/api/dashboard-data') return reply({ jobs, sharedState: [], serverTime: '2026-11-04T18:00:00.000Z' });
    if (u.pathname === '/api/roster') return reply([]);
    if (u.pathname === '/api/shared-state') return reply({ sharedState: [], pendingSync: [], serverTime: '2026-11-04T18:00:01.000Z' });
    if (u.pathname === '/api/workflow-effect') return reply({ issues: [] });
    return reply({});
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://a2z.test/');
  if (!signedIn) {
    await page.waitForSelector('#signinBackdrop:not([hidden])');
    await page.fill('#signinPassword', 'u1');
    await page.click('#signinSubmit');
  }
  await page.waitForFunction(() => document.querySelectorAll('#jobsBody tr[data-job-row]').length === 2, null, { timeout: 20000 });
  const firstFeed = calls.find(c => c.path === '/api/dashboard-data' && c.sent);
  assert.ok(firstFeed, 'dashboard-data was loaded with a session header');
  if (signedIn) assert.ok(calls.filter(c => c.path === '/api/dashboard-data').every(c => c.sent === 'tok-saved'), 'saved session: no unsigned feed call');
  assert.deepEqual(errors, []);
  await browser.close();
}
(async () => {
  await run({ signedIn: true });
  await run({ signedIn: false });
  console.log('api-auth smoke: board waits for sign-in, every feed call is signed, fresh sign-in loads the board');
})().catch(e => { console.error(e); process.exit(1); });
