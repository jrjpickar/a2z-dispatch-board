// Optional browser QA: supply PLAYWRIGHT_MODULE and CHROME_EXECUTABLE if not installed locally.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {

 const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
 const context = await browser.newContext();
 const errors = [], calls = [], resubmits = [];
 const runs=[{id:'old-eod',kind:'eod_sheet',label:'EOD sheet',status:'confirmed',jobId:'job1',jobName:'Test job',date:'2026-10-20',webhook:'https://hook.test/eod',canResubmit:true}];
 const jobs = [{ id:'job1',name:'Test job',sourceType:'labor',contact:{name:'Test client'},customFields:[] }];
 let job = {jobId:'job1',version:1,active:true,crew:[{id:'w1',name:'Worker',phone:'+15555550100'}],scopeOfWork:'Original',reportDate:'2026-09-09',reportTime:'08:00',reportEndDate:'2026-09-09',reportEndTime:'17:00'};
 let move = {moveId:'move1',sourceOpportunityId:'parent1',targetType:'job_addon',sourceType:'demo',jobAddress:'Test move',version:1,active:true,driverName:'Driver',driverId:'d1',assetId:'truck1',assets:[{assetId:'truck1'}],scheduledDate:'2026-09-09',scheduledTime:'08:00',reportDate:'2026-09-09',reportTime:'08:00',status:'assigned'};
 await context.route('**/*', async route => {
  const req=route.request(), u=new URL(req.url()); calls.push(u.pathname);
  if(u.hostname!=='a2z.test')return route.fulfill({body:''});
  const reply = json => route.fulfill({json});
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8')});
  if(u.pathname==='/api/senior'){
   if(req.method()==='POST'){resubmits.push(req.postDataJSON());return reply({ok:true,effectId:'resubmit-new'});}
   if(u.searchParams.get('view')==='history')return reply({runs,sends:[]});
   if(u.searchParams.get('view')==='problems')return reply({effects:[],crm:[]});
   return reply({activity:[]});
  }
  if(u.pathname==='/api/dashboard-data')return reply({jobs,sharedState:[job]});
  if(u.pathname==='/api/logistics-data')return reply({moves:[move]});
  if(u.pathname==='/api/roster')return reply(u.searchParams.get('kind')==='assets'?[{id:'truck1',name:'Truck',status:'assigned',booked:true,moveId:'move1'}]:u.searchParams.get('kind')==='drivers'?[{id:'d1',name:'Driver',status:'booked'}]:[{id:'w1',name:'Worker',phone:'+15555550100'}]);
  if(u.pathname==='/api/workflow-effect')return reply(req.method()==='POST'?{ok:true}:{issues:[]});
  if(u.pathname==='/api/shared-state')return reply({sharedState:[job],pendingSync:[]});
  if(u.pathname==='/api/logistics-state')return reply({states:[move]});
  return reply({});
 });
 const a=await context.newPage(), b=await context.newPage();
 for(const page of [a,b]){page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());await page.goto('https://a2z.test/');await page.waitForFunction(()=>document.getElementById('jobsBody').innerText.includes('Test job'));}


 await a.evaluate(runs=>{currentSession.isSenior=true;seniorWebhookRuns=runs;seniorSends=[{kind:'project_schedule',jobId:'job1',jobName:'Test job',status:'sent',at:new Date().toISOString()}];renderHistory();},runs);
 assert.equal(await a.locator('#webhookHistoryList .webhook-resubmit').count(),1);
 assert.match(await a.locator('#webhookHistoryList').textContent(),/2026-10-20/);
 assert.match(await a.locator('#webhookHistoryList').textContent(),/hook.test/);
 assert.equal(await a.locator('#historyList .webhook-resubmit').count(),1);
 await a.evaluate(()=>document.querySelector('#webhookHistoryList .webhook-resubmit').click());
 await a.waitForFunction(()=>document.getElementById('toast').textContent.includes('Make confirmed'));
 assert.equal(resubmits.length,1);assert.equal(resubmits[0].action,'resubmit_effect');assert.equal(resubmits[0].effectId,'old-eod');assert.ok(resubmits[0].requestId);
 await a.evaluate(()=>{currentSession.isSenior=false;renderHistory();});
 assert.equal(await a.locator('.webhook-resubmit').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: senior resubmit buttons, EOD date/webhook display, request ID and original run sent to server, controls hidden for regular admins.');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
