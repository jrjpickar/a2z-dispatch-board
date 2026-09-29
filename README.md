# A2Z Dispatch 1.8

Read START-HERE.md for deployment and MAKE-SETUP.md for the two Make response changes.

- `npm run build`: validates browser/functions/blueprints/driver app and produces public/index.html and public/driver/.
- `npm test`: mutation and PostgreSQL integration tests.
- Deploy this complete project to the existing Netlify site and database.

Includes the backend, edited dashboard, the read-only Field App for drivers/crew, tests, dependency lockfile, and minimal Make JSON templates. Credentials and production site linkage are not included.

## What's new in 1.8

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
- **Field App** — a read-only mobile web app for drivers and crew at `/driver/` (installable to the home screen). Drivers see their assigned route's stops (in order) and can check a stop off as complete; nothing else is editable. Crew members see the labor job they're on and who else is on that crew. Everything else about a job or move (schedule, pricing, client details, assignment) stays dispatcher-only.
- Turn on access for each person from the "Field App Access" panel on the Logistics tab (pulls from the existing Driver and Labor rosters). Give them the `/driver/` link — they sign in with just their phone number, no code to remember.

## Book Job: GHL assigned user

The Book Job sheet has an **Assigned User** selector (live GHL location users via `/api/ghl-users`; the last pick is remembered on that browser). After Make returns the new opportunity ID, `job-action` checks the lead in GHL:

- Contact has no assigned user: it's set to the selected user.
- Contact already has one: left alone.
- Opportunity has no assigned user: set to whoever owns the contact.

This never fails the booking. If GHL rejects it, the job is still created and the dashboard shows a warning. `GHL_API_TOKEN` needs `users.readonly`, `contacts.readonly` and `contacts.write` (plus the opportunity scopes it already has). Optional `DEFAULT_ASSIGNED_USER_ID` is used if no user was picked (e.g. the user list couldn't load).
