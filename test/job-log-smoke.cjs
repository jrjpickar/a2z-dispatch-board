// Optional browser QA: EOD Done > Completed job log reads /api/job-log, shows rows,
// widens to 7 days, filters by type and search, and shows the not set up message.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const errors = [], reads = [], docPosts = [];
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let notSetUp = false;
  const logRows = [
    { jobId: 'job00000001', action: 'eod_sheet', date: day, jobAddress: '55 Elm St', clientName: 'Acme Builders', monetaryValue: 4200, hoursWorked: 16, reportTime: '07:00', reportEndTime: '15:30', scopeOfWork: 'Demo kitchen and haul debris', pdfId: '11111111-2222-3333-4444-555555555555', docId: 'event:ev1', workers: [{ name: 'Ana Lopez', hours: 8, sentHome: false }, { name: 'Bob Ray', hours: 8, sentHome: true }] },
    { jobId: 'job00000001', action: 'complete', date: day, jobAddress: '55 Elm St', clientName: 'Acme Builders', monetaryValue: 4200, hoursWorked: 0, reportTime: '07:00', workers: [{ name: 'Ana Lopez', hours: null }] },
    { jobId: 'job00000002', action: 'eod_sheet', date: day, jobAddress: '9 Oak Ave', clientName: 'Pine Co', monetaryValue: 900, hoursWorked: 6.5, workers: [{ name: 'Cara Diaz', hours: 6.5 }] }
  ];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
    const reply = json => route.fulfill({ json });
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8') });
    if (u.pathname === '/api/session') return reply({ signedIn: true, user: { id: 'u1', name: 'Sam', email: 's@x' }, via: 'user_id' });
    if (u.pathname === '/api/dashboard-data') return reply({ jobs: [], sharedState: [] });
    if (u.pathname === '/api/shared-state') return reply({ sharedState: [], pendingSync: [] });
    if (u.pathname === '/api/workflow-effect') return reply({ issues: [] });
    if (u.pathname === '/api/job-log' && req.method() === 'POST') { const b = req.postDataJSON(); docPosts.push([u.search, b]); return reply(u.searchParams.has('generate') ? { ok: true, generatedAt: new Date().toISOString() } : { ok: true, doc: b.doc }); }
    if (u.pathname === '/api/job-log' && u.searchParams.get('doc')) return reply({ ok: true, docId: u.searchParams.get('doc'), doc: null });
    if (u.pathname === '/api/job-log') {
      reads.push(Object.fromEntries(u.searchParams));
      if (notSetUp) return route.fulfill({ status: 503, json: { ok: false, notSetUp: true, rows: [], error: 'The job log is not connected yet. Add JOB_LOG_PUSH_SECRET in Netlify (see MAKE-SETUP.md).' } });
      return reply({ ok: true, rows: logRows });
    }
    return reply({});
  });
  await page.goto('https://a2z.test/');
  await page.waitForSelector('#eodDoneViewBtn');
  await page.click('#eodDoneViewBtn');
  await page.click('#jobLogTabBtn');
  await page.waitForFunction(() => document.querySelectorAll('#jobLogBody tr').length === 3);
  assert.deepEqual(reads[0], { from: day, to: day });
  assert.equal(await page.locator('#eodDoneTableWrap').isVisible(), false);
  assert.equal(await page.locator('#eodDoneFilter').isVisible(), false);
  const stats = await page.locator('#jobLogStats').innerText();
  assert.match(stats, /1\s*JOBS COMPLETED/i); assert.match(stats, /2\s*EOD SHEETS/i); assert.match(stats, /22\.5\s*CREW HOURS/i);
  assert.match(await page.locator('#jobLogBody').innerText(), /Sent home/i);
  assert.equal(await page.locator('#jobLogBody a.job-log-pdf').getAttribute('href'), '/api/job-log?pdf=11111111-2222-3333-4444-555555555555');
  await page.waitForTimeout(400);
  await page.screenshot({ path: process.env.SHOT || '/tmp/job-log.png' });
  // Daily Job Log editor: prefilled from the row, edit, save, generate.
  await page.click('#jobLogBody .job-log-edit[data-doc-id="event:ev1"]');
  await page.waitForFunction(() => /Filled from the job log/.test(document.getElementById('jldStatus').textContent));
  assert.equal(await page.inputValue('#jldCustomer'), 'Acme Builders');
  assert.equal(await page.inputValue('#jldAddress'), '55 Elm St');
  assert.equal(await page.inputValue('#jldWork'), 'Demo kitchen and haul debris');
  assert.equal(await page.locator('#jldEmployees tr').count(), 2);
  assert.equal(await page.locator('#jldTotal').innerText(), '16');
  await page.click('#jldAddEmployee');
  await page.locator('#jldEmployees tr').last().locator('.jld-emp-name').fill('Cara Diaz');
  await page.locator('#jldEmployees tr').last().locator('.jld-emp-hours').fill('4');
  assert.equal(await page.locator('#jldTotal').innerText(), '20');
  await page.check('#jldTools input[value="Wheelbarrow"]');
  await page.fill('#jldSuper', 'Steven');
  await page.locator('#jldDisposal tr').first().locator('[data-k="amount"]').fill('85');
  await page.waitForTimeout(400);
  await page.screenshot({ path: (process.env.SHOT || '/tmp/job-log.png').replace(/\.png$/, '-editor.png'), fullPage: false });
  await page.click('#jldSave');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('jldStatus').textContent));
  const saved = docPosts[0][1].doc;
  assert.equal(docPosts[0][0], '?doc=1');
  assert.deepEqual(saved.employees.map(e => [e.name, e.hours, e.sentHome]), [['Ana Lopez', '8', false], ['Bob Ray', '8', true], ['Cara Diaz', '4', false]]);
  assert.deepEqual(saved.tools, ['Wheelbarrow']); assert.equal(saved.superintendent, 'Steven'); assert.equal(saved.disposal[0].amount, '85');
  await page.click('#jldGenerate');
  await page.waitForFunction(() => /Sent to Make/.test(document.getElementById('jldStatus').textContent));
  assert.equal(docPosts[1][0], '?generate=1'); assert.equal(docPosts[1][1].docId, 'event:ev1');
  await page.click('#jldClose');
  assert.equal(await page.locator('#jldBackdrop').isVisible(), false);
  assert.match(await page.locator('#jobLogBody').innerText(), /PDF sent/i);
  await page.selectOption('#jobLogAction', 'complete');
  assert.equal(await page.locator('#jobLogBody tr').count(), 1);
  await page.selectOption('#jobLogAction', 'all');
  await page.fill('#jobSearch', 'cara');
  assert.equal(await page.locator('#jobLogBody tr').count(), 1);
  await page.fill('#jobSearch', '');
  await page.selectOption('#jobLogRange', '7');
  await page.waitForFunction(() => document.querySelectorAll('#jobLogBody tr').length === 3);
  assert.equal(reads.at(-1).to, day); assert.notEqual(reads.at(-1).from, day);
  notSetUp = true;
  await page.click('#jobLogRefresh');
  await page.waitForTimeout(300);
  await page.click('#eodDonePrev');
  await page.waitForFunction(() => /not connected yet/.test(document.getElementById('jobLogBody').innerText));
  await page.click('#eodSheetsTabBtn');
  assert.equal(await page.locator('#eodDoneTableWrap').isVisible(), true);
  assert.equal(await page.locator('#jobLogSection').isVisible(), false);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('job log smoke ok');
})().catch(e => { console.error(e); process.exit(1); });
