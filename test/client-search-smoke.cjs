// Optional browser QA: Book Job client search by name fills the client and sends its GHL contact id.
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
      return reply({ ok: true, contacts: [{ id: 'k1', name: 'Maria Gomez', firstName: 'Maria', lastName: 'Gomez', phone: '+17145550100', email: 'm@x.com', address: '12 Main St, Irvine, CA 92618', companyName: '' },
        { id: 'k2', name: 'Mario Diaz', firstName: 'Mario', lastName: 'Diaz', phone: '', email: '', address: '', companyName: 'Diaz Co' }] });
    }
    if (u.pathname === '/api/job-action') { creates.push(req.postDataJSON()); return route.fulfill({ status: 400, json: { error: 'stop here' } }); }
    if (u.pathname === '/api/dashboard-data') return reply({ jobs: [], sharedState: [] });
    if (u.pathname === '/api/shared-state') return reply({ sharedState: [], pendingSync: [] });
    if (u.pathname === '/api/workflow-effect') return reply({ issues: [] });
    return reply({});
  });
  await page.goto('https://a2z.test/');
  await page.click('#newJobBtn');
  await page.fill('#clientSearch', 'mar');
  await page.waitForSelector('#clientSearchResults button[data-index="1"]');
  assert.equal(searches.at(-1).for, 'client'); assert.equal(searches.at(-1).q, 'mar');
  assert.match(await page.locator('#clientSearchResults').innerText(), /Maria Gomez[\s\S]*12 Main St/);
  await page.click('#clientSearchResults button[data-index="0"]');
  assert.equal(await page.inputValue('#clientFirstName'), 'Maria');
  assert.equal(await page.inputValue('#clientLastName'), 'Gomez');
  assert.equal(await page.inputValue('#clientPhone'), '+17145550100');
  assert.equal(await page.inputValue('#jobAddress'), '12 Main St, Irvine, CA 92618');
  assert.match(await page.locator('#clientPicked').innerText(), /Existing GHL client: Maria Gomez/);
  // Fill the rest and submit: the contact id rides along.
  await page.selectOption('#paymentTerms', 'net-7');
  await page.fill('#jobDate', '2026-10-20'); await page.evaluate(() => { for (const [id, v] of [['jobTime', '07:00'], ['jobEndTime', '15:30']]) { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } });
  await page.click('#submitBook');
  await page.waitForTimeout(400);
  assert.equal(creates.at(-1).clientContactId, 'k1'); assert.equal(creates.at(-1).existingClient, true); assert.equal(creates.at(-1).clientName, 'Maria Gomez');
  // Changing the name drops the link.
  await page.fill('#clientLastName', 'Gomez Ruiz');
  assert.equal(await page.locator('#clientPicked').isHidden(), true);
  await page.click('#submitBook'); await page.waitForTimeout(400);
  assert.ok(!('clientContactId' in creates.at(-1)), 'edited client is sent as typed, no old contact id');
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('Client search smoke passed.');
})().catch(e => { console.error(e); process.exit(1); });
