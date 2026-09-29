// Optional browser QA for 1.8 sign-in/admin tools: node test/admin-smoke.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
const ROOT = process.argv[2] || path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const users = [{ id: 'uJesse0001', name: 'Jesse Pickar', email: 'jesse@a2zcs.net' }, { id: 'uSam000002', name: 'Sam Dispatcher', email: 'sam@a2zcs.net' }];
  const errors = []; const posts = [];
  let manual = [], hidden = [], seniorPosts = [];
  let problemsData = { effects: [{ id: 'req1:eod_sheet', kind: 'eod_sheet', label: 'EOD sheet', status: 'uncertain', error: 'Make did not confirm completion (HTTP 500)', jobId: 'job1', name: 'Test job', action: 'eod_sheet', canRetry: true, at: new Date().toISOString() }], crm: [{ jobId: 'job1', error: 'GHL HTTP 429', at: new Date().toISOString(), name: 'Test job' }] };
  let admins = [{ userId: 'uJesse0001', name: 'Jesse Pickar', email: 'jesse@a2zcs.net', addedBy: 'bootstrap' }];
  async function run(mode) {
    const context = await browser.newContext();
    await context.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url());
      if (u.hostname !== 'a2z.test') return route.fulfill({ body: '' });
      const reply = (json, status = 200) => route.fulfill({ json, status });
      if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8') });
      if (u.pathname === '/ghl-parent') return route.fulfill({ contentType: 'text/html', body: `<body style="margin:0"><iframe id="f" src="/" style="width:1280px;height:720px;border:0"></iframe><script>
        addEventListener('message', e => { if (e.data && e.data.message === 'REQUEST_USER_DATA') e.source.postMessage({ message: 'REQUEST_USER_DATA_RESPONSE', payload: 'ENCRYPTED-CTX' }, '*'); });</script></body>` });
      if (req.method() === 'POST') posts.push({ path: u.pathname, body: req.postDataJSON(), header: req.headers()['x-a2z-session'] });
      const admin = mode === 'admin';
      if (u.pathname === '/api/session') {
        if (req.method() === 'GET') return reply({ signedIn: false });
        const b = req.postDataJSON(); const user = b.action === 'ghl' ? (b.encryptedData === 'ENCRYPTED-CTX' ? users[0] : null) : users.find(x => x.id === b.userId);
        if (!user) return reply({ error: 'bad' }, 401);
        return reply({ ok: true, token: 'tok-' + user.id, signedIn: true, user, via: b.action === 'ghl' ? 'ghl_sso' : 'picker', isAdmin: admin && user.id === 'uJesse0001', isSenior: admin && user.id === 'uJesse0001', needsAdminUnlock: false });
      }
      if (u.pathname === '/api/ghl-users') return reply({ ok: true, users });
      if (u.pathname === '/api/admins') {
        if (req.method() === 'POST') { const b = req.postDataJSON(); admins = b.action === 'add' ? [...admins, { userId: b.userId, name: 'Sam Dispatcher', email: 'sam@a2zcs.net', addedBy: 'Jesse Pickar' }] : admins.filter(a => a.userId !== b.userId); }
        return reply({ ok: true, admins });
      }
      if (u.pathname === '/api/settings') return reply({ defaultAssignedUserId: '', defaultMarkupPercent: 15 });
      if (u.pathname === '/api/senior') {
        if (req.method() === 'POST') { const b = req.postDataJSON(); seniorPosts.push(b); if (b.action === 'save_settings') return reply({ ok: true, settings: { defaultAssignedUserId: b.defaultAssignedUserId, defaultMarkupPercent: Number(b.defaultMarkupPercent), adminPinSet: !!b.adminPin, envPinSet: false, updated: {} } }); problemsData = { effects: [], crm: [] }; return reply({ ok: true, ...problemsData }); }
        const view = u.searchParams.get('view');
        if (view === 'problems') return reply(problemsData);
        if (view === 'activity') return reply({ activity: [{ id: 1, at: new Date().toISOString(), actor: 'Jesse Pickar', action: 'Enrolled admin', target: 'Sam Dispatcher' }] });
        if (view === 'history') return reply({ sends: [{ id: 1, at: new Date().toISOString(), kind: 'eod_sheet', jobId: 'job1', jobName: 'Test job', fileName: 'EOD Sheet - Test job.xlsx', status: 'sent' }, { id: 2, at: new Date().toISOString(), kind: 'project_schedule', jobId: 'job1', jobName: 'Test job', fileName: 'Project Schedule - Test job.pdf', status: 'sent' }] });
        if (view === 'settings') return reply({ defaultAssignedUserId: '', defaultMarkupPercent: 15, adminPinSet: false, envPinSet: false, updated: {} });
      }
      if (u.pathname === '/api/ghl-contacts') return reply({ ok: true, contacts: [{ id: 'cMaria00001', name: 'Maria Gomez', phone: '+15555550199', email: '' }] });
      if (u.pathname === '/api/manual-workers') {
        if (req.method() === 'POST' && ['hide', 'unhide'].includes(req.postDataJSON().action)) { const b = req.postDataJSON(); hidden = b.action === 'hide' ? [{ key: 'id:' + b.contactId, contactId: b.contactId, name: b.name, phone: b.phone, hiddenBy: 'Jesse Pickar' }] : []; return reply({ ok: true, workers: manual, hidden }); }
        if (req.method() === 'POST') { manual = [{ contactId: 'cMaria00001', name: 'Maria Gomez', phone: '+15555550199', labor: true, driver: true }]; return reply({ ok: true, worker: { name: 'Maria Gomez' }, fieldApp: { driverKey: 'phone:5555550199' }, workers: manual, hidden }); }
        return reply({ workers: manual, hidden });
      }
      if (u.pathname === '/api/dashboard-data') return reply({ jobs: [{ id: 'job1', name: 'Test job', sourceType: 'labor', contact: { name: 'Client' }, customFields: [] }], sharedState: [] });
      if (u.pathname === '/api/roster') return reply(u.searchParams.get('kind') === 'labor' ? [{ id: 'w1', name: 'Worker', phone: '+15555550100' }] : u.searchParams.get('kind') === 'drivers' ? [{ id: 'd1', name: 'Driver', phone: '+15555550111' }] : []);
      if (u.pathname === '/api/logistics-data') return reply({ moves: [] });
      if (u.pathname === '/api/logistics-state') return reply({ states: [] });
      if (u.pathname === '/api/driver-codes') return reply({ enabled: [] });
      if (u.pathname === '/api/workflow-effect') return reply({ issues: [] });
      if (u.pathname === '/api/shared-state') return reply({ sharedState: [], pendingSync: [] });
      if (u.pathname === '/api/project-schedule') return reply({ schedules: [] });
      return reply({});
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(mode + ': ' + e.message));
    page.on('dialog', d => d.accept());
    return { page, context };
  }
  // 1. Admin opens the board inside GHL: parent frame answers REQUEST_USER_DATA.
  let { page, context } = await run('admin');
  await page.goto('https://a2z.test/ghl-parent');
  const outer = page;
  await outer.waitForFunction(() => document.getElementById('f').contentWindow.document.readyState === 'complete');
  page = outer.frames().find(f => f.url() === 'https://a2z.test/');
  await page.waitForFunction(() => !document.getElementById('whoamiRole').hidden);
  assert.equal(await page.textContent('#whoamiText'), 'Jesse Pickar · jesse@a2zcs.net');
  assert.equal(await page.textContent('#whoamiRole'), 'SENIOR ADMIN');
  assert.ok(await page.isHidden('#switchUserBtn'), 'no switch inside GHL');
  assert.ok(await page.isVisible('#adminViewTab'));
  // No add/remove on the board itself; that lives on the Admin page.
  await page.waitForFunction(() => document.getElementById('rosterList').textContent.includes('Worker'));
  assert.equal(await page.locator('#rosterList button').count(), 0);
  assert.ok(await page.isHidden('#signinBackdrop'));
  const signin = posts.find(p => p.path === '/api/session');
  assert.deepEqual([signin.body.action, signin.body.encryptedData], ['ghl', 'ENCRYPTED-CTX']);
  // Session header rides on later API calls.
  await page.click('#newJobBtn');
  await page.waitForFunction(() => document.getElementById('assignedUser').options.length > 2);
  assert.equal(await page.inputValue('#assignedUser'), 'uJesse0001');
  await page.selectOption('#assignedUser', 'uSam000002');
  await page.evaluate(() => closeSheetFn && closeSheetFn());
  await page.click('#newJobBtn');
  assert.equal(await page.inputValue('#assignedUser'), 'uJesse0001', 'reopening resets to signed-in user');
  await page.evaluate(() => closeSheetFn());
  // Admin page
  await page.click('#adminViewTab');
  await page.waitForSelector('#adminLaborList .roster-remove[data-name="Worker"]');
  await page.click('#adminLaborList .roster-remove[data-name="Worker"]');
  await page.waitForFunction(() => !dashboardData.labor.some(w => w.name === 'Worker') && logisticsLoaded && document.getElementById('hiddenWorkerList').textContent.includes('Worker'));
  assert.ok(!(await page.textContent('#rosterList')).includes('Worker'));
  assert.ok(await page.isVisible('#fieldAppAccessPanel'));
  await page.waitForSelector('#adminUserList .admin-toggle[data-action="add"]');
  await page.click('#adminUserList .admin-toggle[data-user-id="uSam000002"]');
  await page.waitForSelector('#adminUserList .admin-toggle[data-action="remove"][data-user-id="uSam000002"]');
  assert.ok((await page.textContent('#adminCount')).startsWith('2 ADMINS'));
  await page.click('#hiddenWorkerList .hidden-restore');
  await page.waitForFunction(() => dashboardData.labor.some(w => w.name === 'Worker'));
  await page.click('#addGhlWorkerBtn');
  await page.fill('#ghlWorkerSearch', 'mar');
  await page.waitForSelector('#ghlWorkerResults button[data-index]');
  await page.click('#ghlWorkerResults button[data-index="0"]');
  await page.check('#ghlWorkerDriver');
  await page.click('#saveGhlWorker');
  await page.waitForFunction(() => dashboardData.labor.some(w => w.name === 'Maria Gomez') && logisticsData.drivers.some(d => d.name === 'Maria Gomez'));
  const addPost = posts.find(p => p.path === '/api/manual-workers' && p.body.action === 'add');
  assert.equal(addPost.header, 'tok-uJesse0001');
  assert.deepEqual([addPost.body.contactId, addPost.body.labor, addPost.body.driver, addPost.body.fieldApp], ['cMaria00001', true, true, true]);
  await page.waitForTimeout(500); const fieldRows = await page.textContent('#fieldAppAccessList');
  assert.ok(fieldRows.includes('Maria Gomez') && fieldRows.includes('Enable'));
  await outer.screenshot({ path: '/tmp/admin.png', fullPage: false });
  await page.click('#cancelGhlWorker'); await page.waitForTimeout(400);
  // Senior admin tools
  assert.ok(await page.isVisible('#seniorTools'));
  await page.waitForFunction(() => document.getElementById('problemCount').textContent === '2' && document.getElementById('historyList').textContent.includes('Project Schedule PDF'));
  assert.ok((await page.textContent('#activityList')).includes('Jesse Pickar'));
  await page.click('#problemList .problem-btn[data-action="retry_effect"]');
  await page.waitForFunction(() => document.getElementById('problemCount').textContent === '0');
  assert.deepEqual(seniorPosts[0], { action: 'retry_effect', effectId: 'req1:eod_sheet' });
  assert.equal(await page.inputValue('#setMarkup'), '15');
  await page.selectOption('#setDefaultUser', 'uSam000002'); await page.fill('#setMarkup', '20'); await page.fill('#setPin', '9876');
  await page.click('#saveSettings');
  await page.waitForFunction(() => boardDefaults.defaultAssignedUserId === 'uSam000002');
  assert.deepEqual(seniorPosts[1], { action: 'save_settings', defaultAssignedUserId: 'uSam000002', defaultMarkupPercent: '20', adminPin: '9876' });
  await page.evaluate(() => document.getElementById('seniorTools').scrollIntoView());
  await outer.screenshot({ path: '/tmp/adminsheet.png' });
  await context.close();
  // 2. Regular user without link: picker, no admin controls.
  ({ page, context } = await run('user'));
  await page.goto('https://a2z.test/');
  await page.waitForFunction(() => !document.getElementById('signinBackdrop').hidden && document.getElementById('signinUser').options.length > 2);
  await page.screenshot({ path: '/tmp/signin.png' });
  await page.selectOption('#signinUser', 'uSam000002');
  await page.click('#signinSubmit');
  await page.waitForFunction(() => document.getElementById('signinBackdrop').hidden);
  assert.equal(await page.textContent('#whoamiRole'), 'USER');
  assert.ok(await page.isVisible('#switchUserBtn'));
  assert.ok(await page.isHidden('#adminViewTab'));
  assert.equal(await page.locator('#rosterList button').count(), 0);
  assert.ok(await page.isHidden('#seniorTools'));
  await context.close();
  await browser.close();
  assert.deepEqual(errors, []);
  console.log('smoke 1.8 OK');
})().catch(e => { console.error(e); process.exit(1); });
