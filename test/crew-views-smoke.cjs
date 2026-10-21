// Optional browser QA: supply PLAYWRIGHT_MODULE and CHROME_EXECUTABLE if not installed locally.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {

 const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
 const context = await browser.newContext();
 const errors = [], calls = [];
 const jobs = [{ id:'job1',name:'Test job',sourceType:'labor',contact:{name:'Test client'},customFields:[] }];
 let job = {jobId:'job1',version:1,active:true,crew:[{id:'w1',name:'Worker',phone:'+15555550100'}],scopeOfWork:'Original',reportDate:'2026-09-09',reportTime:'08:00',reportEndDate:'2026-09-09',reportEndTime:'17:00'};
 let move = {moveId:'move1',sourceOpportunityId:'parent1',targetType:'job_addon',sourceType:'demo',jobAddress:'Test move',version:1,active:true,driverName:'Driver',driverId:'d1',assetId:'truck1',assets:[{assetId:'truck1'}],scheduledDate:'2026-09-09',scheduledTime:'08:00',reportDate:'2026-09-09',reportTime:'08:00',status:'assigned'};
 await context.route('**/*', async route => {
  const req=route.request(), u=new URL(req.url()); calls.push(u.pathname);
  if(u.hostname!=='a2z.test')return route.fulfill({body:''});
  const reply = json => route.fulfill({json});
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8')});
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

 await a.evaluate(()=>{const j=dashboardData.jobs[0]; dashboardData.sharedStateByJobId.get(j.id).crewSize=2; renderJobs(dashboardData.jobs);});
 await a.selectOption('#laborCrewFilter','needs');
 assert.equal(await a.locator('#jobsBody tr[data-job-row]').count(),1);
 await a.selectOption('#laborCrewFilter','full');
 assert.equal(await a.locator('#jobsBody tr[data-job-row]').count(),0);
 await a.evaluate(()=>{dashboardData.sharedStateByJobId.get('job1').crewSize=1;renderJobs(dashboardData.jobs);});
 assert.equal(await a.locator('#jobsBody tr[data-job-row]').count(),1);
 await a.evaluate(()=>{dashboardData.sharedStateByJobId.get('job1').crewSize=null;renderJobs(dashboardData.jobs);});
 assert.equal(await a.locator('#jobsBody tr[data-job-row]').count(),0);
 await a.evaluate(()=>{document.getElementById('logisticsDispatchView').hidden=false;});
 await a.evaluate(()=>loadLogistics());
 await a.selectOption('#logisticsCrewFilter','full');
 assert.equal(await a.locator('#logisticsMoves tr[data-move-key]').count(),1);
 await a.selectOption('#logisticsCrewFilter','needs');
 assert.equal(await a.locator('#logisticsMoves tr[data-move-key]').count(),0);
 await a.evaluate(()=>{logisticsData.moves[0].driverId='';logisticsData.moves[0].driverName='';renderLogistics();});
 assert.equal(await a.locator('#logisticsMoves tr[data-move-key]').count(),1);
 await a.selectOption('#logisticsCrewFilter','full');
 assert.equal(await a.locator('#logisticsMoves tr[data-move-key]').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS: partial/full/unknown labor crews and full/missing-driver logistics; no browser errors.');
 await browser.close();
})().catch(error=>{console.error(error);process.exitCode=1;});
