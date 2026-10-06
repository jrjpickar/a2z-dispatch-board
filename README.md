# A2Z Dispatch 1.8

Read START-HERE.md for deployment and MAKE-SETUP.md for the two Make response changes.

- `npm run build`: validates browser/functions/blueprints/driver app and produces public/index.html and public/driver/.
- `npm test`: mutation and PostgreSQL integration tests.
- Deploy this complete project to the existing Netlify site and database.

Includes the backend, edited dashboard, the read-only Field App for drivers/crew, tests, dependency lockfile, and minimal Make JSON templates. Credentials and production site linkage are not included.

## Worker sent home, job search, Completed tab

- **Worker sent home** (top bar, left of Dark Mode). Lists every worker on an open job (on today first, with search). Dispatch picks the worker and the hours worked (half hour steps up to 16; filled in from the job's start time when it started today). The worker is released from that job right away, and the board posts to `https://hook.us2.make.com/mo2wtttzdfhpl4liym6c8uw3pbq6mmth` (override with `WORKER_SENT_HOME_WEBHOOK`). No removal text goes to the worker. The hours are also kept on the job (`sentHome`) and in the Activity log. See MAKE-SETUP.md.
- **Search bar** on Jobs Scheduled: matches address, client, crew, scope, job ID and change order parent. Shows "x of y"; Esc clears it.
- **Completed tab** (after Schedule). Jobs marked Completed or Cancelled on the board now leave Labor Dispatch (and the Jobs Scheduled count) and are listed here, newest first, with search and a filter (All closed, Completed, Cancelled, Still active in GHL). A job GHL still lists as active is flagged and has **Reopen job**, which puts it back on Labor Dispatch. Name, client and value are saved when a job closes so the row still reads right after GHL drops it; jobs closed before this deploy show what the board had.

## Fix: jobs stuck as "closed" (can't add crew or schedule)

- **Cause.** Completed / Cancelled closes the job on the board right away, then asks Make to move the GHL stage. If GHL still lists the job as active afterwards (the Make stage update didn't go through, someone moved it back in GHL, Completed was clicked on the wrong row, or it's a change order, since the Change Order pipeline isn't filtered by stage), the row looked completely normal but every save was refused with "This job is closed. Reopen it explicitly", and there was no way to reopen it.
- **Now** that row shows a grey Completed / Cancelled tag, "Closed on the board by <name> <date>, but GHL still shows it as an active job", and a **Reopen job** button. Crew assign and time editing are hidden until it's reopened, and the error message points to Reopen job.
- **Reopen job** makes it editable again on the board only (GHL already shows it as active). Times and details are kept; the crew stays cleared since it was released when the job closed.
- Completed, Cancelled and Reopened are now recorded on the job (`closedBy`, `closedAt`, `reopenedBy`, `reopenedAt`) and in the Activity log, so the next one can be traced.
- Tests: `test/reopen.test.mjs` (in `npm test`) and the optional browser check `test/closed-job-smoke.cjs`.

## Change orders linked to the parent job

- **Link job as change order** in Edit Job Details. Pick the parent job from the board (jobs for the same client are listed first, then everything else, with search). The job is moved into the Change Order pipeline in GHL (status stays won) and then linked. If GHL refuses the move, nothing is linked and GHL's reason is shown. A job already in the Change Order pipeline just gets linked.
- **Change parent job** and **Unlink** show once a job is linked. Unlinking leaves the job in the Change Order pipeline in GHL.
- **On the board**, the parent job shows a note under its address listing each change order with its value (and Completed or Cancelled once closed); click one to jump to its row. The change order shows its Change Order badge with "for <parent job>".
- No nesting: a change order can't be a parent, and a job with change orders can't become one.
- Stored on the change order's shared record (`parentJobId`, `parentJobName`, `changeOrderName`, `changeOrderLinkedBy`, `changeOrderLinkedAt`) through `/api/shared-state` actions `link_change_order` / `unlink_change_order`. Links and unlinks show in the Activity log.
- GHL: the stage is the Change Order pipeline's first stage, or `CHANGE_ORDER_STAGE_ID` if set. `CHANGE_ORDER_PIPELINE_ID` still overrides the pipeline. The token's existing opportunity scopes cover it.
- Tests: `test/change-order.test.mjs` (in `npm test`) and the optional browser check `test/change-order-smoke.cjs`.

## What's new in 1.8

- **Complete EOD Sheet also fires the job log webhook** (`vqurtuiu…`, kind `job_log`, override with `JOB_LOG_WEBHOOK`): job details, the day's report/end date and time, and the crew as `assignedWorkers`, captured before the reset. JSON, independent of the EOD sheet call; each is confirmed and retryable on its own. See MAKE-SETUP.md.
- **Fix: empty Complete EOD runs in Make.** The EOD sheet used to post one big JSON body with the ~200 KB workbook inside it as base64 text, and Make logged those runs with no data. It now posts like the Project Schedule does: `multipart/form-data`, the .xlsx as a real binary `file`, every other field as a plain form field. The dashboard and server also refuse to post a blank EOD (no job id or no filled line). **Make change needed, see MAKE-SETUP.md.** `EOD_SHEET_FORMAT=json` in Netlify brings the old JSON body back if you need it temporarily.
- **Signed-in user.** Top left under the logo, like the dialer: name, email and ADMIN / USER. Inside GHL it signs in automatically the same way the Triple Line dialer does (GHL Custom Page encrypted user context, checked with `GHL_APP_SHARED_SECRET`). Outside GHL it asks once ("Who's using the board?") and the browser remembers; Switch user shows only then.
- **Admin page** (new tab to the right of Schedule, admins only). This is the only place laborers are added or removed; the board itself has no add/remove buttons.
  - **Admins:** senior admins see every GHL user with **Enroll** / **Revoke**; other admins see the admin list read-only.
  - **Laborers:** **+ Add from GHL** (contact search; Crew and/or Driver; optional Field App sign-in), **On the board** (every laborer, with search and **Remove**), **Added from GHL**, and **Removed from the board** with **Restore**. Removing a Make roster laborer only hides them on the board (GHL and Make untouched).
  - **Field App Access** moved here from Logistics.
- **Senior admin** (Jesse Pickar; `SENIOR_ADMINS`, formerly `BOOTSTRAP_ADMINS`): always admin, can't be revoked, and the only role that can enroll or revoke admins. Shown as SENIOR ADMIN.
- **Senior admin section** (bottom of the Admin page, senior admins only):
  - **Make / GHL problems:** Make runs that weren't confirmed (EOD, notifications, job stage/details, driver logs) and GHL schedule syncs that failed, with **Retry** (same run and eventId sent again) and **Mark resolved**. Runs from before this deploy can only be marked resolved (their payload wasn't kept).
  - **Settings:** default Assigned User for Book Job (default: whoever is signed in), default markup % on the EOD sheet, and an admin PIN (stored hashed; works alongside `DASHBOARD_ADMIN_PIN`).
  - **Activity log:** who enrolled/revoked admins, added/removed/restored laborers, enabled/revoked Field App access, retried or resolved problems, and changed settings.
  - **Send history:** every EOD sheet and Project Schedule PDF sent (or failed), grouped by job, searchable. Starts with this deploy; Project Schedules sent earlier show their last send.
- **Edit workers** (admins): **Edit** next to a laborer, a GHL-added worker, or anyone in Field App Access opens first name, last name and phone, loaded fresh from GHL. **Save to GHL** writes them to the GHL contact (phone saved as +1XXXXXXXXXX), then the board follows: GHL-added list, Field App sign-in moves to the new phone, crews on open jobs and drivers on open moves get the new name/phone, and the Make roster cache is cleared so the next load re-reads it. If GHL refuses (e.g. duplicate phone), nothing changes and GHL's reason is shown.
- **Send schedule now** in the crew picker, next to Assign selected: same assignment, but each worker's run to the worker webhook has `action: "rapid_assign"` (plus `rapidAssign: true`) so Make can send the schedule immediately. See MAKE-SETUP.md.
- **Make runs are optimistic.** After a save, notifications / EOD / job stage runs to Make are treated as sent right away. The board waits up to 45 seconds for Make's `{"ok":true}`; only then does it show a toast and list it under Make / GHL problems. A plain "Accepted" reply is named as such (the route is missing its Webhook response). `MAKE_TIMEOUT_MS` changes the server wait.
- Every Make/GHL problem that existed before this deploy is acknowledged once, automatically, so the list starts clean. **Acknowledge** / **Acknowledge all** clear items without sending anything.
- The server enforces all of it: admins for laborers, worker edits and Field App access, senior admins for the admin list and the senior section.
- **Assigned User is required on Book Job** and starts on whoever is signed in. It can be changed per booking; each new booking starts on you again. The server fills in the signed-in user if a booking arrives without one. Make also gets `bookedBy` / `bookedByUserId`.

## What's new in 1.7

- **Project Schedule plans with crew and days together.** Each phase has its own Crew, Work days and Loads boxes; nothing is worked out from building size anymore. Building size, dumpster size and usable capacity are gone from the form, the preview and the PDF. Crew-days = crew x work days.
- Stretching a bar on the Schedule tab changes only its days; the crew stays as set.
- Schedules saved before 1.7 are converted once when read, so their crew, days and loads stay the same.
- The Project Schedule webhook no longer sends `squareFeet`, `dumpsterSize` or `dumpsterUsable`; each phase in `phases` now has `crew`, `workDays`, `loads`, `crewDays`, `fromDay`, `toDay`.

## What's new in 1.6

- **Night work.** A Night work switch on Book Job and Edit Job Details, and a Night tick box next to the end time on the board. With it on, an end time earlier than the start (8:00 PM to 5:00 AM) means the next morning: a blank or same-day end date rolls forward one day on its own, and the sheet shows when the shift ends. An explicit later end date is kept as typed. Without it, an overnight end is refused with a hint to turn Night work on.
- Stored on the job (`nightWork` in shared state; a day reset keeps it) and shown as a NIGHT badge on the board.
- Sent to Make as `nightWork` (true/false) and `shiftType` ("night"/"day") on: **Completed / Cancelled** (job stage webhook, now also with the job's report/end date and time), the **EOD sheet**, create job, edit job details, and worker assignment notifications. No GHL field is needed; map it in Make where you want it.

## What's new in 1.4

- **Project Schedule for Contract (Demo) jobs.** A "Project Schedule" button on every contract job opens the sheet: building SF, dumpster size, schedule mode, and per-phase crew or target days. The four formulas (person-days, work days rounded up, crew worked backward, dumpster loads) run live with a preview of the printed page.
- **Save** stores the schedule on the board (shared with every dispatcher, versioned so two people can't overwrite each other). **Submit** saves it, draws the PDF on the server, and posts it to Make as multipart/form-data: the PDF is binary in field `file`, with flat fields (`jobId`, `jobName`, `startDate`, `plannedFinish`, `totalWorkdays`, `totalLoads`, `crewDays`, `peakCrew`, ...) and JSON strings `phases` and `safety`.
- **Schedule tab.** Lists every contract job; expand one to see its totals, a day-by-day timeline, and the phase table, with Edit and View PDF.
- **Drag the timeline.** On the Schedule tab, drag a bar to move a phase (the layout becomes Custom), drag either end to change its days (the crew is worked backward to fit), and drag the grip to reorder. Arrow keys move a focused bar, Shift+arrows change its length, Alt+Up/Down reorders. **Update PDF** saves the changes and sends a fresh PDF to the same webhook; **Save changes** keeps them without sending. In order / All at once lines everything back up.
- Days-first phases now book exactly the days you set (crew = person-days / days, rounded up). Peak crew counts phases that overlap on the same day.
- **Blank PDF** (`/api/project-schedule?blank=1`) is a fill-by-hand version of the form.
- Webhook: `https://hook.us2.make.com/ym8j30bvydhops1cbq53y4yjypzx7z8k`. Override with the `PROJECT_SCHEDULE_WEBHOOK` env var. A plain "Accepted" response counts as success; a JSON reply with `ok: false` is shown as an error.
- New dependency: `pdf-lib` (pinned). New table: `project_schedules` (created automatically).

## What's new in 1.3

- **Phone-only sign-in for the Field App.** No more access codes to hand out or type. A dispatcher enables a person once (Field App Access panel), and from then on they just enter their phone number.
- **Spanish/English toggle in the Field App.** An EN/ES switch in the top bar translates the sign-in screen and every route/job/stop label. The choice is remembered on that phone.

## What's new in 1.2

- **Multi-stop routes.** A logistics move can now carry an ordered list of stops (address, type, date/time window, notes) instead of just one pickup and one destination. Add stops from the "Book Standalone Container" and "Edit" sheets on the Logistics tab. Older single-address moves keep working unchanged.
- **Field App**: a read-only mobile web app for drivers and crew at `/driver/` (installable to the home screen). Drivers see their assigned route's stops (in order) and can check a stop off as complete; nothing else is editable. Crew members see the labor job they're on and who else is on that crew. Everything else about a job or move (schedule, pricing, client details, assignment) stays dispatcher-only.
- Turn on access for each person from the "Field App Access" panel on the Logistics tab (pulls from the existing Driver and Labor rosters). Give them the `/driver/` link. They sign in with just their phone number, no code to remember.

## Book Job: GHL assigned user

The Book Job sheet has an **Assigned User** selector (live GHL location users via `/api/ghl-users`; the last pick is remembered on that browser). After Make returns the new opportunity ID, `job-action` checks the lead in GHL:

- Contact has no assigned user: it's set to the selected user.
- Contact already has one: left alone.
- Opportunity has no assigned user: set to whoever owns the contact.

This never fails the booking. If GHL rejects it, the job is still created and the dashboard shows a warning. `GHL_API_TOKEN` needs `users.readonly`, `contacts.readonly` and `contacts.write` (plus the opportunity scopes it already has). Optional `DEFAULT_ASSIGNED_USER_ID` is used if no user was picked (e.g. the user list couldn't load).

## Admin page layout and charts

The Admin page is a grid of panels with one shared layout (`dispatch_settings` key `adminLayout`, served by `/api/admin-dashboard`). A senior admin clicks **Customize layout** to drag panels into a new order, drag the bottom-right corner to resize (width snaps to a 12-column grid; double-click the corner for auto height), hide/show panels, and set **Who sees it** per panel: all admins or senior admins only. Settings is always senior only. Any admin can collapse a panel on their own browser.

"Who sees it" is enforced on the server, not just hidden: Problems, Activity log and Send history can be shared read-only with admins (Retry/Acknowledge stay senior only), and limiting Laborers or Field App Access to senior admins also blocks those admin actions (`lib/layout.mjs` `requirePanel`).

Charts (`lib/dashboard-stats.mjs`, board time zone `BOARD_TIME_ZONE`, default America/Los_Angeles): jobs on site per day and crew booked per day (next 14 days), job value by week (last 8 + next 4, by start week), and Make run health (last 14 days). Job value and Make health start as senior only.
