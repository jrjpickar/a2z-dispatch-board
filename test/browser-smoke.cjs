// Optional browser QA: supply PLAYWRIGHT_MODULE and CHROME_EXECUTABLE if not installed locally.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {
 const { mutateJob, mutateMove, checkVersion } = await import(pathToFileURL(path.resolve(__dirname, '../lib/state.mjs')));
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
  if(u.pathname==='/api/shared-state'||u.pathname==='/api/logistics-state'){
   const isJob=u.pathname==='/api/shared-state';
   if(req.method()==='GET')return reply(isJob?{sharedState:[job],pendingSync:[]}:{states:[move]});
   const payload=req.postDataJSON(), current=isJob?job:move;
   try{
    checkVersion(current,payload);
    const next=(isJob?mutateJob:mutateMove)({version:current.version,active:current.active,data:current},payload);
    if(isJob){job={...next.data,active:next.active,jobId:'job1',version:current.version+1};return reply({ok:true,record:job,crmSync:{ok:true}});}
    move={...next.data,moveId:'move1',version:current.version+1};return reply({ok:true,state:move});
   }catch(error){return route.fulfill({status:error.status||400,json:{error:error.message}});}
  }
  return reply({});
 });
 const a=await context.newPage(), b=await context.newPage();
 for(const page of [a,b]){page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());await page.goto('https://a2z.test/');await page.waitForFunction(()=>document.getElementById('jobsBody').innerText.includes('Test job'));}
 // Reset in A must appear in B, including blank dates and crew.
 await a.evaluate(()=>resetJobDay('job1',document.createElement('button')));
 await b.evaluate(()=>pollSharedState());
 assert.equal(await b.evaluate(()=>getReportDate(dashboardData.jobs[0])), '');
 assert.deepEqual(await b.evaluate(()=>getCrew(dashboardData.jobs[0])), []);
 // Old local values cannot revive explicit clears.
 await b.evaluate(()=>{window.jobDetailsOverride.job1={scopeOfWork:'stale'};});
 job={...job,scopeOfWork:'',version:job.version+1};
 await b.evaluate(()=>pollSharedState());
 assert.equal(await b.evaluate(()=>getScopeOfWork(dashboardData.jobs[0])), '');
 // A stale write must show the conflict and leave state unchanged.
 job={...job,scopeOfWork:'New dispatcher',version:job.version+1};
 await a.evaluate(()=>saveJobTimes('job1','2026-09-10','09:00','2026-09-10','17:00',document.createElement('button')));
 assert.equal(job.reportDate,'');assert.match(await a.locator('#toast').innerText(),/Another dispatcher/);
 // Logistics reset must clear schedules/drivers/assets across pages.
 await a.evaluate(()=>loadLogistics());await b.evaluate(()=>loadLogistics());
 await a.evaluate(()=>resetLogisticsDay('parent1',Object.assign(document.createElement('button'),{textContent:'Reset'})));
 await b.evaluate(()=>pollSharedState());
 assert.equal(await b.evaluate(()=>logisticsData.moves[0].scheduledDate),'');
 assert.equal(await b.evaluate(()=>getLogisticsDriverName(logisticsData.moves[0])),'');
 assert.equal(await b.evaluate(()=>logisticsData.assets[0].status),'available');
 // Polling must never reload roster / Make sources.
 const before=calls.filter(p=>p==='/api/roster').length;
 await b.evaluate(()=>pollSharedState());
 assert.equal(calls.filter(p=>p==='/api/roster').length,before);
 assert.deepEqual(errors,[]);
 console.log('PASS: two-browser resets, cleared-value precedence, stale-write error, vehicle release, and Make-free polling; no page errors.');
 await a.screenshot({path:path.resolve(__dirname,'../../dispatch-board-qa.png'),fullPage:true});
 await browser.close();
})().catch(error=>{console.error(error);process.exitCode=1;});
