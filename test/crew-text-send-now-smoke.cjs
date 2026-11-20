// Browser QA: Text crew (job row dropdown) replaced Send now. Run node scripts/build-sandbox.mjs first.
// A quick click only hints, a 2 s hold does nothing, a 5 s hold opens the confirm prompt,
// Cancel sends nothing, Send text sends that one worker's Make run and text.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); const path = require('path'), assert = require('assert/strict');
(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + path.resolve(__dirname, '../sandbox/schedule-text-sandbox.html'));
  await page.waitForSelector('#jobsBody .crewtext-menu', { timeout: 15000 });
  assert.equal(await page.locator('#jobsBody .job-crewtext-now').count(), 0, 'no Send now on job rows');
  const menu = page.locator('#jobsBody .crewtext-menu').first();
  await menu.locator('summary').click();
  const btn = menu.locator('.crewtext-worker-btn').first();
  await btn.waitFor({ state: 'visible' });
  const dialogOpen = () => page.locator('#crewTextNowBackdrop').evaluate(e => !e.hidden);
  const sent = () => page.evaluate(() => document.body.innerText.match(/Schedule text and Make run sent for/g)?.length || 0);
  await btn.click(); await page.waitForTimeout(300);
  assert.equal(await dialogOpen(), false, 'quick click does not open the prompt');
  const hold = async ms => { const b = await btn.boundingBox(); await page.mouse.move(b.x + 15, b.y + 10); await page.mouse.down(); await page.waitForTimeout(ms); await page.mouse.up(); await page.waitForTimeout(300); };
  await hold(2000); assert.equal(await dialogOpen(), false, '2 second hold does nothing');
  await hold(5300); assert.equal(await dialogOpen(), true, '5 second hold opens the prompt');
  await page.click('.crewtext-now-cancel'); await page.waitForTimeout(300);
  assert.equal(await dialogOpen(), false); assert.equal(await sent(), 0, 'Cancel sends nothing');
  await hold(5300); await page.click('#crewTextNowConfirm'); await page.waitForTimeout(800);
  const text = await page.evaluate(() => document.body.innerText);
  assert.match(text, /Schedule text and Make run sent for /);
  assert.match(text, /workers · (rapid_assign|assign)[^\n]*\n\{[\s\S]*?"sentFrom": "worker_text_now"/, 'the worker webhook run went out too');
  assert.deepEqual(errors, []);
  console.log('Text crew OK');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
