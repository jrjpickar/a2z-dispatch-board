# Make changes

Keep your existing notification and driver-log action modules. No new everyday scenarios are required.

## 1. Confirm finished actions

**Worker assign sends one run per worker.** When a dispatcher confirms an assignment, the worker scenario gets a separate webhook call for each assignee. Each payload has the job fields plus `workerName`, `workerPhone`, `contactId` at the top level, `assignedWorkers` containing just that one worker (so old mappings still work; no iterator needed), and `workerIndex` / `workerCount` (e.g. 2 of 3). Every run must still end with the `{"ok":true}` response below.

At the END of each successful worker assign/remove, driver assign/remove, job edit/stage, container edit/stage and driver-log route, use **Webhooks → Webhook response**:

- Status: `200`
- Body: `{"ok":true}`
- Header: `Content-Type` = `application/json`

`make-blueprints/01-confirm-finished.json` contains that single response module. Import it into a temporary blank scenario, copy the module, and paste it LAST on your existing successful routes. Replace an existing response rather than adding another. Do not activate the temporary scenario: it contains no notification/log actions.

Never return success before the actual work finishes or from an error/ignore route. Plain `Accepted` means queued, not confirmed; the dashboard will flag it.

## Send schedule now (worker webhook, action `rapid_assign`)

The crew picker has two buttons once workers are ticked: **Assign selected** (action `assign`; Make texts the schedule 12 hours before the start time) and **Send schedule now** (action `rapid_assign`). Both save the same crew on the board and post one run per worker to the worker webhook `https://hook.us2.make.com/dk8dm3t7opzdpmemah0gor2wiq3swq5l` with the same fields (`jobId`, `jobAddress`, `clientName`, `clientPhone`, `scopeOfWork`, `toolsRequired`, `monetaryValue`, `reportDate`, `reportTime`, `reportEndDate`, `reportEndTime`, `nightWork`, `shiftType`, `workerName`, `workerPhone`, `contactId`, `assignedWorkers`, `workerIndex`, `workerCount`, `eventId`). The rapid run also has `rapidAssign: true`. Every assignment run also has `timeZone: "America/Los_Angeles"` (times are Pacific wall clock times). **Don't text workers** in the picker, and **Don't text** in the Remove worker and Unschedule boxes, send no run at all to this webhook (or the split day one), so nothing in those routes runs for that change. Set Make's organization time zone to Pacific so the 12 hour reminder lines up.

Add a router path filtered on `action` = `rapid_assign` that sends the schedule right away, and end it with the `{"ok":true}` Webhook response. Until that path exists, rapid runs match no route and will show under Admin > Make / GHL problems after 45 seconds.

## Split day booking (new webhook)

**Split day** in **+ Assign crew** means: each ticked worker works this job **and one other job** that day, and gets **one** text covering both. Dispatch turns on Split day, ticks the workers (available or already booked), and for each one must pick the other job and that worker's times at each job before **Assign selected** or **Send schedule now** will work.

The board puts the worker on both jobs (if they were not already on the other job) and posts **one run per split worker** to `https://hook.us2.make.com/pnoqc8i87kix7qiyjkmfek9axgvjh4z6` (override with `SPLIT_DAY_WEBHOOK` in Netlify). No run goes to the worker webhook for a split worker, for either job, so do any GHL association or labor status update for both jobs in this scenario. Workers assigned with Split day off still go to the normal worker webhook.

Fields: everything a normal assignment sends (`jobId`, `jobAddress`, `clientName`, `clientPhone`, `scopeOfWork`, `toolsRequired`, `monetaryValue`, `reportDate`, `reportTime`, `reportEndDate`, `reportEndTime`, `nightWork`, `shiftType`, `workerName`, `workerPhone`, `contactId`, `assignedWorkers`, `workerIndex`, `workerCount`, `eventId`, plus the worker time fields below) and:

- `action`: `"split_day_assign"`, `splitDay`: `true`, `sendNow` (`true` for **Send schedule now**), `originalAction` (`assign` or `rapid_assign`).
- `jobCount`: `2`. Both jobs come as **numbered flat fields, no arrays**: job 1 is the job being assigned, job 2 is the other job dispatch picked. For each N in 1 and 2: `jobIdN`, `jobAddressN`, `clientNameN`, `clientPhoneN`, `scopeOfWorkN`, `toolsRequiredN`, `monetaryValueN`, `reportDateN`, `reportTimeN`, `reportEndDateN`, `reportEndTimeN`, `nightWorkN`, `shiftTypeN`, and the worker's own `workerReportDateN`, `workerReportTimeN`, `workerReportEndDateN`, `workerReportEndTimeN`, `customTimeN`. Example: `jobAddress1`, `jobAddress2`, `workerReportTime1`, `workerReportTime2`.
- `addedToJob2`: `true` if the board just added the worker to job 2, `false` if they were already on it.
- The unnumbered job fields (`jobId`, `jobAddress`, `reportTime`, `workerReportTime`, ...) are still sent and always equal job 1. `assignedWorkers` is the same one item list every assignment has always sent.

End the scenario with the `{"ok":true}` Webhook response. Without it every split day booking shows under Admin > Make / GHL problems (as "Split day booking") after 45 seconds. The worker stays on both jobs on the board either way.

## Worker times (every assignment)

Every assignment run (worker webhook and split day webhook) now also carries the worker's own times in the same format as the job's: `workerReportDate`, `workerReportTime` (`HH:MM`), `workerReportEndDate`, `workerReportEndTime` (`HH:MM`) and `customTime`. They equal the job's `reportDate` / `reportTime` / `reportEndDate` / `reportEndTime` unless dispatch set custom times for that worker (**Custom times for a worker** in the crew picker, or the times on a Split day row), in which case `customTime` is `true`. If a custom end is earlier than the start, `workerReportEndDate` is the next day. Map the text's times to `workerReportTime` / `workerReportEndTime` so custom times reach the worker. The job's own `reportTime` / `reportEndTime` never change.

## Worker sent home (new webhook)

The **Worker sent home** button posts JSON to `https://hook.us2.make.com/mo2wtttzdfhpl4liym6c8uw3pbq6mmth` (override with `WORKER_SENT_HOME_WEBHOOK` in Netlify), one run per worker:

`jobId`, `workerName`, `hoursWorked` (a number, like `5.5`), plus `action` (`"worker_sent_home"`), `opportunityId` (same as `jobId`), `workerPhone`, `contactId`, `jobAddress`, `clientName`, `reportDate`, `reportTime`, `reportEndDate`, `reportEndTime`, `nightWork`, `shiftType`, `sentHomeAt` and `eventId`.

End the scenario with the `{"ok":true}` Webhook response. Without it every send shows under Admin > Make / GHL problems after 45 seconds (the worker is still released on the board either way).

## Complete EOD Sheet route (worker webhook)

The job **Complete EOD Sheet** button (formerly Reset Day) posts the Job Costing Worksheet to the same worker webhook Reset Day already used: `https://hook.us2.make.com/dk8dm3t7opzdpmemah0gor2wiq3swq5l` (or `EOD_SHEET_WEBHOOK` / `WORKER_EFFECT_WEBHOOK` if set in Netlify). Add a router path filtered on `action` = `eod_sheet` and end it with the `{"ok":true}` Webhook response above. No separate `remove` event is sent. The released crew is included in `removedWorkers` if you want to notify them from this route.

**Job log (second call on Complete EOD Sheet).** The button also posts plain JSON to the job log webhook `https://hook.us2.make.com/vqurtuiuxdbg9k1j7v03prsffquvh1xa` (override with `JOB_LOG_WEBHOOK` in Netlify). Fields: `jobId`, `action` (`"eod_sheet"`), `jobAddress`, `clientName`, `clientPhone`, `scopeOfWork`, `toolsRequired`, `monetaryValue`, `reportDate`, `reportTime`, `reportEndDate`, `reportEndTime`, `assignedWorkers` (array of `contactId`, `workerName`, `workerPhone`: the crew before the reset), plus `eventId`. The schedule fields are taken before the board clears the day. End that scenario with the same `{"ok":true}` Webhook response, or every EOD will show a Job log problem under Admin > Make / GHL problems.

**1.8 change: the EOD sheet now arrives as `multipart/form-data`** (like the Project Schedule PDF), not JSON. The old JSON body carried the ~200 KB workbook as base64 text and Make was logging those runs with no data. After deploying:

1. Open the worker scenario, click the Custom Webhook module, **Redetermine data structure**, then submit one EOD sheet from the board so Make relearns the fields.
2. `file` is now a real binary file (the filled Job Costing Worksheet .xlsx). In Google Drive upload / email attachment / Slack file modules, map **`file`** directly (Make fills the file name and data). Replace any old `{{toBinary(file.data; "base64")}}` and `{{file.fileName}}` mappings; `fileName` is also sent as its own field.
3. Flat fields keep their names and arrive as text: `action`, `jobId`, `opportunityId`, `jobName`, `jobAddress`, `clientName`, `date`, `submittedAt`, `interiorSubtotal`, `exteriorSubtotal`, `gradingSubtotal`, `totalJobCost`, `markupPercent`, `totalPriceToCustomer`, `nightWork` (`"true"`/`"false"`), `shiftType`, `fileName`, `eventId`, and every Google Sheets field below. Existing `{{2.INTERIOR_LABOR_DESC}}`-style mappings keep working after step 1.
4. Lists arrive as JSON text: `lines`, `sections`, `crew`, `removedWorkers`. If a route uses them, wrap with `parseJSON` (e.g. an Iterator over `{{parseJSON(2.removedWorkers)}}`).
5. Still end the route with the `{"ok":true}` Webhook response.

Setting `EOD_SHEET_FORMAT=json` in Netlify temporarily restores the old JSON body (with `file.data` base64) while you switch the mapping over.

Lines: all 19 template rows are sent, blanks included (`section`, `category`, `line`, `description`, `qty`, `rate`, `lineTotal`). Blank EOD sheets (no filled line or no job id) are never posted.

Google Sheets fields (top level, named to match the values batchUpdate placeholders): `INTERIOR_LABOR_DESC/_QTY/_RATE`, `INTERIOR_HOTEL_*`, `INTERIOR_HAULING_*`, `INTERIOR_EQUIPMENT_1_*`, `INTERIOR_EQUIPMENT_2_*`, `INTERIOR_FUEL_*`, `INTERIOR_MISC_*`, `EXTERIOR_LABOR_*`, `EXTERIOR_HAULING_*`, `EXTERIOR_EQUIPMENT_1_*` to `_3_*`, `EXTERIOR_FUEL_*`, `EXTERIOR_MISC_*`, `GRADING_LABOR_*`, `GRADING_HAULING_*`, `GRADING_EQUIPMENT_*`, `GRADING_FUEL_*`, `GRADING_MISC_*`, and `MARKUP_PERCENT` (sent like `"20%"` so USER_ENTERED stores 0.2). Blank boxes arrive empty. Map them as `{{2.INTERIOR_LABOR_DESC}}` etc. (module 2 = the webhook).

## Job create: who booked it (1.8)

The create-job payload now also has `bookedBy` and `bookedByUserId` (the signed-in dispatcher). `assignedUserId` / `assignedUserName` are always filled. Map them if you want them in GHL or Slack; nothing breaks if you don't.

## 2. Return the created opportunity ID

Your existing job-create and standalone-container-create routes must end with:

```json
{"ok":true,"opportunityId":"THE_ACTUAL_CREATED_OPPORTUNITY_ID"}
```

Use `02-return-created-id.json` the same way. Replace `MAP_CREATED_OPPORTUNITY_ID_HERE` with the mapped **ID output of your Create Opportunity module**. Other routes still return `{"ok":true}`. Keep the existing webhook URLs.

## Remove duplicate state work

After deploying and confirming your records are in Netlify:

- Disable the old dashboard/shared-state read/write scenarios, Save Times scenario, both daily-reset scenarios, and add-on state-sync scenario.
- In scenarios you KEEP, remove modules that write the old job-shared-state/logistics-move-state stores or merely mirror this board’s asset assignment status. Keep unrelated business records, GHL contact/opportunity updates, notifications, and the actual driver-log destination.
- Keep the labor, driver and asset catalog/roster sources. Netlify calls each at most once every five minutes while needed, across browsers. Do not delete the asset catalog. Its booking/release routes are no longer called by this build.
- Generate driver logs once: this dashboard explicitly calls the existing log workflow on completion of a move with a driver and on its daily reset. Remove duplicate log-generation modules from container completion/reset routes.

Shared-state saves and automatic shared-state refreshes use **zero Make credits**. Notifications, remaining CRM actions, logs and roster cache fills still consume Make credits; Netlify/GHL usage is separate.

## Optional imports: skip if Netlify already has your records

`03-optional-import-job.json` and `04-optional-import-logistics.json` each contain webhook → HTTP → response. These are one-time migration helpers, not recurring scenarios.

1. Import into a NEW scenario; create/select a webhook in module 1.
2. Replace the site URL in HTTP module 2 with your Netlify site URL.
3. Set a random `STATE_SYNC_TOKEN` in Netlify. Put the same value after `Bearer ` in module 2’s Authorization header. Never put it in HTML.
4. Send the matching `*-import-sample.json` to the webhook after replacing example IDs/values with one real old record. `recordJson` is a JSON string with `action: "import"`, `expectedVersion: 0`, and a unique `requestId`.
5. Run once per missing record. Reuse the SAME requestId and payload when retrying a record. Existing Netlify rows are rejected, not overwritten.
6. Turn these scenarios OFF when migration is done.

Each import has three modules, no searches/iterators/aggregators/Data Store writes. Posting directly to Netlify avoids Make entirely.

## Unconfirmed actions

The dispatch save remains intact. Check the matching Make execution before replaying anything; a message may already have sent. Do not use assign/create again as a notification retry. Repair the failed execution as appropriate. Workflow issues are stored in `dispatch_effects`; an administrator can mark a reviewed row confirmed after checking Make. GHL schedule retries have a separate Retry button and do not resend notifications.

## Template limits

These JSON files are hand-built templates validated as JSON, not exports of your private scenarios or tested imports into your account. The source ZIP did not contain your notification text, routing, connections or log destination, so those stay in the existing scenarios.

Sources: [Make blueprints](https://help.make.com/blueprints), [webhook responses](https://apps.make.com/gateway), [credits](https://help.make.com/credits), [GHL schedule field updates](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/opportunities/update-opportunity/).
