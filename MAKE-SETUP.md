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

The crew picker has two buttons once workers are ticked: **Assign selected** (action `assign`; sent to Make at the 6:30 PM run, see below; Make texts the schedule 12 hours before the start time) and **Send schedule now** (action `rapid_assign`). Both save the same crew on the board and post one run per worker to the worker webhook `https://hook.us2.make.com/dk8dm3t7opzdpmemah0gor2wiq3swq5l` with the same fields (`jobId`, `jobAddress`, `clientName`, `clientPhone`, `scopeOfWork`, `toolsRequired`, `monetaryValue`, `reportDate`, `reportTime`, `reportEndDate`, `reportEndTime`, `nightWork`, `shiftType`, `workerName`, `workerPhone`, `contactId`, `assignedWorkers`, `workerIndex`, `workerCount`, `eventId`). The rapid run also has `rapidAssign: true`. Every assignment run also has `timeZone: "America/Los_Angeles"` (times are Pacific wall clock times). **Don't text workers** in the picker, and **Don't text** in the Remove worker and Unschedule boxes, send no run at all to this webhook (or the split day one), so nothing in those routes runs for that change. Set Make's organization time zone to Pacific so the 12 hour reminder lines up.

**6:30 PM daily run (assign / remove workers).** Assign selected, the x on a crew chip and Unschedule save the crew on the board right away, but their runs to Make (worker webhook actions `assign` and `remove`, and `split_day_assign` on the split day webhook) wait on the server until **6:30 PM Pacific every day**. Send schedule now in the crew picker (`rapid_assign`) still goes right away, and Don't text still sends nothing. At 6:30 PM each job goes out **as it sits at that point**, one job every 15 seconds (tomorrow's jobs first, by start time): per worker only the net change goes to Make (assigned and still on the job: their `assign` run with the job's current times; was on and now off: their `remove` run; assigned then removed, or removed then put back, before 6:30: nothing). Every job row has **Send now** next to Unschedule (with the number of waiting changes, e.g. Send now · 2): hold it for 5 seconds in its box and that job goes out right away the same way. Run by `netlify/functions/nightly-dispatch.mjs` (cron 01:30 and 02:30 UTC, acts only 6:30 to 7:59 PM Pacific, once a day) and `nightly-dispatch-background.mjs` (up to 15 minutes). Waiting runs don't show as problems; a run that fails shows under Admin > Make / GHL problems as usual.

**Crew schedule text (action `crewText`), no Make.** The server texts each worker the schedule for **their job only** (day, date, that job as (CLIENT), address, start - end and `* Worker` lines with `Name 4hr` for a worker split between jobs that day, then `buenas noches guys`) through Twilio, once per job and day (nobody gets the same job's text twice). The 6:30 PM run texts everyone on **tomorrow's** jobs who hasn't gotten it; Send now on a job texts anyone on that job who hasn't gotten it; Send schedule now in the picker texts the workers in that assignment right away. Each text is logged in that worker's GHL conversation the same way the Triple Line dialer logs calls: Marketplace app OAuth token + Conversation Provider, added to the worker's GHL conversation (found, or made if they have none) with `POST /conversations/messages/inbound`, `type: "SMS"`, `direction: "outbound"`, the Twilio SID as `altId`. GHL sends nothing itself. To check the GHL connection open `https://<board>/api/oauth/callback?status`. Problems show under Admin > Make / GHL problems as **Crew schedule text**; Retry only redoes what didn't finish (nobody is texted twice).

Netlify env for it: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (or `TWILIO_MESSAGING_SERVICE_SID`, which wins if both are set), `GHL_APP_CLIENT_ID`, `GHL_APP_CLIENT_SECRET`, `GHL_SMS_CONVERSATION_PROVIDER_ID`, and optional `PUBLIC_APP_URL` (the board's address; defaults to the address the callback is opened on), `CREW_TEXT_DRY_RUN=true` (build and record, send nothing), `CREW_TEXT_GHL_LOG=false` (text only, no GHL log). GHL setup: in the dispatch board Marketplace app add the scopes `conversations.readonly`, `conversations.write` and `conversations/message.write`, add the redirect URL `https://<board>/api/oauth/callback`, create an **SMS** Conversation Provider (Delivery URL `https://<board>/api/crew-text-delivery`, "custom conversation provider" unchecked; don't make it the location's default SMS provider, or GHL would route its own texts to it) and put its ID in `GHL_SMS_CONVERSATION_PROVIDER_ID`, then open `https://<board>/api/oauth/callback` in a browser signed in to GHL: it sends you to GHL's location picker, you approve, and it comes back to the board and saves the token (the page says **A2Z Dispatch connected**). Updating the app in GHL alone may not send the token to the board. Then hit Retry on any failed Crew schedule text rows.

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

**Job log (second call on Complete EOD Sheet).** The button also posts plain JSON to the job log webhook `https://hook.us2.make.com/vqurtuiuxdbg9k1j7v03prsffquvh1xa` (override with `JOB_LOG_WEBHOOK` in Netlify). Fields: `jobId`, `action` (`"eod_sheet"`), `jobAddress`, `clientName`, `clientPhone`, `scopeOfWork`, `toolsRequired`, `monetaryValue`, `hoursWorked` (total of every worker's hours on that day's EOD sheet, sent home workers included), `reportDate`, `reportTime`, `reportEndDate`, `reportEndTime`, `assignedWorkers` (array of `contactId`, `workerName`, `workerPhone`: the crew before the reset), plus `eventId`. The schedule fields are taken before the board clears the day. End that scenario with the same `{"ok":true}` Webhook response, or every EOD will show a Job log problem under Admin > Make / GHL problems.

**1.8 change: the EOD sheet now arrives as `multipart/form-data`** (like the Project Schedule PDF), not JSON. The old JSON body carried the ~200 KB workbook as base64 text and Make was logging those runs with no data. After deploying:

1. Open the worker scenario, click the Custom Webhook module, **Redetermine data structure**, then submit one EOD sheet from the board so Make relearns the fields.
2. `file` is now a real binary file (the filled Job Costing Worksheet .xlsx). In Google Drive upload / email attachment / Slack file modules, map **`file`** directly (Make fills the file name and data). Replace any old `{{toBinary(file.data; "base64")}}` and `{{file.fileName}}` mappings; `fileName` is also sent as its own field.
3. Flat fields keep their names and arrive as text: `action`, `jobId`, `opportunityId`, `jobName`, `jobAddress`, `clientName`, `date`, `submittedAt`, `interiorSubtotal`, `exteriorSubtotal`, `gradingSubtotal`, `totalJobCost`, `totalCrewHours`, `CREW_COUNT`, `CREW_1_NAME` / `CREW_1_HOURS` (one pair per worker), `nightWork` (`"true"`/`"false"`), `shiftType`, `fileName`, `eventId`, and every Google Sheets field below. Existing `{{2.INTERIOR_LABOR_DESC}}`-style mappings keep working after step 1.
4. Lists arrive as JSON text: `lines`, `sections`, `crew`, `crewHours`, `removedWorkers`. If a route uses them, wrap with `parseJSON` (e.g. an Iterator over `{{parseJSON(2.removedWorkers)}}`).
5. Still end the route with the `{"ok":true}` Webhook response.

Setting `EOD_SHEET_FORMAT=json` in Netlify temporarily restores the old JSON body (with `file.data` base64) while you switch the mapping over.

Lines: all 19 template rows are sent, blanks included (`section`, `category`, `line`, `description`, `qty`, `rate`, `lineTotal`). Blank EOD sheets (no filled line or no job id) are never posted.

Google Sheets fields (top level, named to match the values batchUpdate placeholders): `INTERIOR_LABOR_DESC/_QTY/_RATE`, `INTERIOR_HOTEL_*`, `INTERIOR_HAULING_*`, `INTERIOR_EQUIPMENT_1_*`, `INTERIOR_EQUIPMENT_2_*`, `INTERIOR_FUEL_*`, `INTERIOR_MISC_*`, `EXTERIOR_LABOR_*`, `EXTERIOR_HAULING_*`, `EXTERIOR_EQUIPMENT_1_*` to `_3_*`, `EXTERIOR_FUEL_*`, `EXTERIOR_MISC_*`, `GRADING_LABOR_*`, `GRADING_HAULING_*`, `GRADING_EQUIPMENT_*`, `GRADING_FUEL_*`, `GRADING_MISC_*`. Blank boxes arrive empty. There is no markup any more (`MARKUP_PERCENT`, `markupPercent` and `totalPriceToCustomer` are gone; remove those mappings). Map them as `{{2.INTERIOR_LABOR_DESC}}` etc. (module 2 = the webhook).

**Crew hours (no pay rates).** The EOD sheet lists every worker on the job plus anyone sent home from it that day. Each starts at 8 hours, and dispatch can change any of them. A worker sent home shows the hours picked on **Worker sent home**. They are in `crewHours` (`workerName`, `hoursWorked`, `sentHome`, `contactId`, `workerPhone`) and on the workbook under CREW HOURS, where Markup % and Total price to customer used to be.

## Completed job log (EOD Done > Completed job log)

Make sends the job log rows to the board, the board saves them, and the Completed job log tab reads them from there (fast, no waiting on Make).

**Netlify:** add `JOB_LOG_PUSH_SECRET` (any long random string, its own value, not one another app uses).

**Make, HTTP > Make a request** (add it in the job log scenario right after the sheet row is added, so every new row also lands on the board):

- URL: `https://<dispatch board site>/api/job-log`
- Method: POST
- Header: `x-make-secret` = the `JOB_LOG_PUSH_SECRET` value
- Body content type: JSON (or Custom with content type `application/json`)
- Body: one row, an array of rows, or `{ "rows": [...] }`
- Parse response: yes. The board answers `{ "ok": true, "saved": 1, "skipped": 0 }`.

Each row needs these fields (any capitalization or spacing works, so sheet headers like `Job ID` or `Hours Worked` are fine):

- `jobId`, `action` (`eod_sheet` or `complete`)
- `date` (the work day; `reportDate` is used if there is no `date`; `YYYY-MM-DD` or `M/D/YYYY`). Rows with no date are skipped.
- `jobAddress`, `clientName`, `scopeOfWork`, `monetaryValue`, `hoursWorked`
- `reportTime`, `reportEndTime`
- `assignedWorkers`: the array from the job log payload (`workerName`, `hoursWorked`, `sentHome`), its JSON text, or a plain `Ana Lopez, Bob Ray` list
- optional: `eventId` or `rowId` (the same id sent again updates that row instead of adding a copy), `loggedAt` (timestamp, sorts same day rows), `submittedBy`

Passing the job log webhook bundle straight through works: it already has all of these plus `eventId`.

**Backfill / resync (run once, or whenever the sheet was edited by hand):** Google Sheets Search Rows > Array aggregator > the same HTTP module with body `{ "replaceFrom": "2026-01-01", "replaceTo": "2026-10-31", "rows": [aggregated rows] }`. The board clears that date range first, then saves the rows, so it matches the sheet exactly. Send 4 MB or less per call (split by month if needed).

**Other option (pull):** if `JOB_LOG_READ_WEBHOOK` is set, the board asks Make instead, posting `{ "action": "read", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }` and expecting a Webhook response with the rows as a JSON array. Leave it unset to use the pushed rows.

Until one of the two is set the tab says the job log is not connected yet.

## Job hours webhook (retired)

The board no longer posts to `https://hook.us2.make.com/swmlb2j1ef0k89fesawlizhmur714kqo` (`JOB_HOURS_WEBHOOK` is no longer read). The day's total crew hours now go on the job log as `hoursWorked` (see Complete EOD Sheet above). You can turn that scenario off in Make. Any old Job hours runs still listed under Admin > Make / GHL problems can't be retried; press Resolve on them.

## New worker webhook (Admin > Workers > + Add from GHL)

Adding (or updating) a worker from GHL posts one plain JSON run to `https://hook.us2.make.com/wk9leiggp4mlr2g5n1acq862y6my52ia` (override with `LABOR_ADDED_WEBHOOK` in Netlify). Fields: `action` (`"newWorker"`), `contactId`, `workerName`, `firstName`, `lastName`, `workerPhone`, `email`, `tags`, `crew` (true/false), `driver` (true/false), `roles` (`Crew`, `Driver` or `Crew/Driver`), `fieldApp` (true/false), `isNew` (false when the worker was already added and was just updated), `addedBy`, `addedByUserId`, `addedAt`, `eventId`. The board saves the worker first and sends this in the background, so the admin never waits on Make. End the scenario with the `{"ok":true}` Webhook response; a run Make doesn't confirm shows under Admin > Make / GHL problems with Retry.

## Logistics reminder webhook (3pm Pacific)

Every day at 3pm Pacific (`LOGISTICS_REMINDER_HOUR` in Netlify changes the hour) the board checks **tomorrow's** open logistics moves. If any are missing a saved time, a driver or a vehicle, it posts one plain JSON run to `https://hook.us2.make.com/cw5dsqfr8qsr5vb9hr1rehspyl6pa3v2` (override with `LOGISTICS_REMINDER_WEBHOOK`). Once a day; nothing is sent when every move is ready. Admins can send it any time with **Send reminder now** on the Logistics page (`forced: true`).

Fields: `action` (`"logistics_reminder"`), `date` (tomorrow, `YYYY-MM-DD`), `dayLabel` (like `Fri, Oct 16`), `totalMoves`, `readyMoves`, `needsAttention`, `missingDriverCount`, `missingVehicleCount`, `missingTimeCount`, `summary` (one sentence, ready for Slack), `movesText` (one line per move, ready for Slack), `moves` (array: `moveId`, `jobId`, `jobAddress`, `clientName`, `movementType`, `equipment`, `time`, `timeLabel`, `driverName`, `vehicles`, `missing`, `missingTime`, `missingDriver`, `missingVehicle`, `ready`), `boardUrl`, `forced`, `sentAt`, `jobId` (`logistics-<date>`), `eventId`. End the scenario with the `{"ok":true}` Webhook response.

**Labor reminder (same webhook, same fields).** Right after the logistics run, a second run goes to the same webhook for **tomorrow's labor jobs** with the exact same field names, `action: "labor_reminder"`. For a labor job: `missingDriverCount` / `missingDriver` = no crew, `missingVehicleCount` / `missingVehicle` = crew short of its crew size, `missingTimeCount` / `missingTime` = no start or end time; in `moves[]`, `driverName` is the crew's names and `vehicles` is like `1 of 4 crew`. `summary` and `movesText` read naturally (e.g. `2 of 3 labor jobs for Fri, Oct 16 need attention: 1 no crew, 1 short crew, 1 no time.`), so the same Slack mapping works for both; route on `action` if you want them in different channels. Also once a day, only when something is missing (`LABOR_REMINDER_WEBHOOK` overrides the URL).

## Truck loads (driver log webhook)

Each Logistics move has a **Loads** box next to Driver and Vehicle. Saving it stores the number of truck loads for that day on the move.

- **Standalone containers:** saving posts JSON to the driver log webhook `https://hook.us2.make.com/tp2wwcdltmjyi1gsrc9mhywksiygqouo` with `action: "loadCount"`, `loadCount` (number), `moveId`, `jobId`, `opportunityId`, `sourceOpportunityId`, `date`, `driverName`, `vehicles`, `jobAddress`, `clientName`, `containerSize`, `movementType`, `enteredBy`, `enteredAt`, `eventId`.
- **Contract job add-ons:** no webhook. The job's **Complete EOD Sheet** adds up that day's loads on its moves and fills the first empty Hauling line with "Full Truck Load (excludes dump fees)", qty = loads, $375 a load (never overwriting a line already filled). The EOD payload also carries `truckLoads` and `truckLoadMoves`.
- **Reset Day on a Logistics move** now always posts the day's log to the same webhook with `action: "jobLog"` (was `reset_dispatch`, and only when a driver was on it) plus `loadCount` for that day. Every other field is the same as before (`date`, `employee`, `hours`, `signature`, `lunch`, `rows`, addresses, driver, vehicle). Route on `action` in Make: `jobLog`, `loadCount`, and `complete` (the Completed driver log, unchanged).

## Book Job: existing client (search by name)

Book Job has a **Find client** search (GHL contacts by name). Picking one fills First/Last name, phone and (if empty) Job Address, and the create run also carries `clientContactId` (the GHL contact id), `existingClient: true` and `clientEmail`. If the name or phone is edited after picking, those are not sent. Map `clientContactId` in the create scenario to reuse that contact instead of searching/creating one.

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
