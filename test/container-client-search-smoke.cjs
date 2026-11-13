// Optional browser QA: Book Standalone Container client search sends the GHL contact id,
// and the Logistics tab hides + Book Job (only + Book Container).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [], searches = [], creates = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    const reply = json => route.fulfill({ json });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply({ signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'user_id' });
    if (u.pathname === '/api/ghl-users') return reply({ users: [{ id: 'u1', name: 'Sam' }] });
    if (u.pathname === '/api/ghl-contacts') {
      searches.push(Object.fromEntries(u.searchParams));
      return reply({ ok: true, contacts: [{ id: 'k1', name: 'Maria Gomez', firstName: 'Maria', lastName: 'Gomez', phone: '+17145550100', email: 'm@x.com', address: '12 Main St, Irvine, CA 92618', companyName: '' }] });
    }
    if (u.pathname === '/api/container-action') { creates.push(req.postDataJSON()); return route.fulfill({ status: 400, json: { error: 'stop here' } }); }
    if (u.pathname === '/api/logistics-data') return reply({ moves: [] });
    if (u.pathname === '/api/logistics-state') return reply({ states: [], serverTime: new Date().toISOString() });
    if (u.pathname === '/api/dashboard-data') return reply({ jobs: [], sharedState: [] });
    if (u.pathname === '/api/shared-state') return reply({ sharedState: [], pendingSync: [] });
    if (u.pathname === '/api/workflow-effect') return reply({ issues: [] });
    return reply({});
  });
  await page.goto('https://a2z.test/');
  assert.equal(await page.locator('#newJobBtn').isVisible(), true, 'Book Job shows on Labor');
  await page.click('#logisticsViewTab');
  assert.equal(await page.locator('#newJobBtn').isVisible(), false, 'Book Job hidden on Logistics');
  assert.equal(await page.locator('#newContainerBtn').isVisible(), true);
  await page.click('#newContainerBtn');
  await page.fill('#containerClientSearch', 'mar');
  await page.waitForSelector('#containerClientSearchResults button[data-index="0"]');
  assert.equal(searches.at(-1).for, 'client'); assert.equal(searches.at(-1).q, 'mar');
  await page.click('#containerClientSearchResults button[data-index="0"]');
  assert.equal(await page.inputValue('#containerFirstName'), 'Maria');
  assert.equal(await page.inputValue('#containerLastName'), 'Gomez');
  assert.equal(await page.inputValue('#containerPhone'), '+17145550100');
  assert.equal(await page.inputValue('#containerAddress'), '12 Main St, Irvine, CA 92618');
  assert.match(await page.locator('#containerClientPicked').innerText(), /Existing GHL client: Maria Gomez/);
  await page.selectOption('#containerPaymentTerms', 'net-7');
  await page.fill('#containerDate', '2026-11-20'); await page.evaluate(() => { const el = document.getElementById('containerTime'); el.value = '07:00'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.click('#submitContainerBook'); await page.waitForTimeout(600);
  assert.equal(creates.at(-1).clientContactId, 'k1'); assert.equal(creates.at(-1).existingClient, true); assert.equal(creates.at(-1).clientEmail, 'm@x.com');
  // Editing the name drops the link.
  await page.fill('#containerLastName', 'Gomez Ruiz');
  assert.equal(await page.locator('#containerClientPicked').isHidden(), true);
  await page.click('#submitContainerBook'); await page.waitForTimeout(600);
  assert.ok(!('clientContactId' in creates.at(-1)), 'edited client is sent as typed');
  // Back to Labor: Book Job returns.
  await page.click('#closeContainerSheet');
  await page.click('#laborViewTab');
  assert.equal(await page.locator('#newJobBtn').isVisible(), true);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('Container client search smoke passed.');
})().catch(e => { console.error(e); process.exit(1); });
