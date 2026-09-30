# Deploy A2Z Dispatch 1.8

1. Replace the files in your existing Netlify-connected repository with this folder’s contents. Keep the SAME Netlify site and database.
2. Keep `GHL_API_TOKEN` in Netlify environment variables. Netlify Database supplies `NETLIFY_DB_URL`; never paste it into the page.
3. **Add a new environment variable: `DRIVER_TOKEN_SECRET`.** This signs the Field App's driver/crew sign-in tokens. Set it to any long random string (e.g. `openssl rand -hex 32`) and never reuse it elsewhere. The build/deploy will still succeed without it, but the Field App's sign-in and route/job endpoints will return a 500 until it's set.
4. Apply the Make changes in MAKE-SETUP.md (1.8: the EOD route now receives multipart; redetermine its data structure and remap `file`).
5. Deploy normally. Build: `npm run build`. Publish: `public`. Functions: `netlify/functions`. Node: 22 or newer.
6. Reload all open dashboard tabs after deployment. Old tabs cannot overwrite new state.

## Sign-in and admins (new in 1.8)

Automatic sign-in works exactly like the Triple Line dialer: the board runs as a **Custom Page** of your private GHL Marketplace app, asks GHL for the logged-in user (`REQUEST_USER_DATA`), and the server checks GHL's encrypted answer with the app's Shared Secret. No login screen inside GHL.

1. **Add the Custom Page.** In the HighLevel Developer Marketplace, open the same private app the dialer uses (or a new private app). Add a **Custom Page** module in the left navigation, URL = your dispatch Netlify URL (e.g. `https://YOUR-SITE.netlify.app/`), nothing in the query string. Save and update the app installation for the A2Z location.
2. **Netlify env vars:**
   - `GHL_APP_SHARED_SECRET`: the app's Shared Secret (Auth/Secrets area). Same value as the dialer's if you reuse its app. Required for automatic sign-in.
   - `GHL_LOCATION_ID`: only if not `QUcu2PEAxPV1sQm1GQCq`. Users from other locations are refused.
   - `SESSION_SECRET` (optional): signs board sessions. Falls back to `DRIVER_TOKEN_SECRET`.
   - `DASHBOARD_ADMIN_PIN` (optional): lets admins turn on admin tools when using the board outside GHL.
   - `SENIOR_ADMINS` (optional, old name `BOOTSTRAP_ADMINS` still works): extra senior admins by name, email or GHL user id, comma separated. `jesse@a2zcs.net` is always a senior admin (built into the code) even if this is deleted, blank or wrong.
3. **Inside GHL** people are signed in as themselves every time the page opens (switching GHL users switches the board). The session is remembered for 7 days in a signed cookie plus a header copy, since GHL's iframe can block cookies.
4. **Outside GHL** (bookmark, phone) the board asks once "Who's using the board?" and remembers that browser for 180 days. That picker never grants admin rights by itself: use the admin PIN, or open the board inside GHL once (that session also works outside GHL for 7 days).
5. **Admin tab** (right of Schedule): admins, laborers (add from GHL / remove / restore) and Field App Access. Senior admins (Jesse Pickar) can't be revoked and are the only ones who can enroll or revoke admins.
6. Server-enforced: admins for laborers and Field App access, senior admins for the admin list.
7. The GHL API token still needs `users.readonly` and `contacts.readonly`.

## Night work (new in 1.6)

- No setup needed. Make scenarios that receive job payloads now get `nightWork` and `shiftType`; map them where you want them (GHL custom field, worker SMS text, EOD sheet). Existing mappings keep working.

## Project Schedule (new in 1.4)

- Nothing to configure for it to work: the `project_schedules` table is created on first use and Submit posts to the Project Schedule Make webhook already set in the code. Set `PROJECT_SCHEDULE_WEBHOOK` only if you move that scenario.
- In Make, the Custom Webhook receives the PDF under `file` (binary data + file name). Map `file` straight into a Google Drive upload, email attachment, or GHL file field. Run one Submit with the scenario listening so Make learns the structure.
- `npm install` picks up the new `pdf-lib` dependency (both lockfiles are updated).

## Field App (read-only, for drivers and crew)

- Lives at `/driver/` on the same site. No separate deployment, app store, or hosting needed. Give someone the link and tell them to "Add to Home Screen" for an app-like icon.
- On the Logistics tab, open the **Field App Access** panel and click **Enable** next to a driver or crew member's name (pulled from the existing Driver and Labor rosters). Give them the `/driver/` link. They sign in with just their phone number, nothing else to hand out. **Revoke** removes their access; **Enable** again to restore it.
- Sign-in is phone-number-only, by design, so it's low-friction for the crew. That also means anyone who knows an enabled person's phone number could open their route/job if they had the link. That's reasonable for an internal crew, but worth knowing. Revoke access as soon as someone leaves.
- A driver sees only the logistics moves assigned to them (matched by phone, or name if no phone is on file), in stop order, and can tap a stop to mark it done/not done. Nothing else on the board is reachable from there.
- A crew member sees only the labor job(s) they're on the crew for, and the names of their coworkers on that job. No pricing, client contact details beyond what's already shown, or other jobs.
- Who's enabled is stored in the database (`dispatch_driver_codes`; the name is legacy, there's no code in it anymore), not in Make/GHL. There's no separate "employee" system to keep in sync. It just matches whatever name/phone is already on the job or move.
- An **EN/ES** switch in the Field App's top bar translates the sign-in screen and every route/job/stop label. It defaults to the phone's own language and remembers whatever the person picks.

## Multi-stop routes

- A move's `stops` field (set from the Logistics "Book Standalone Container" / "Edit" sheets) is now the source of truth for its route when present. The single Pickup/Delivery Address fields still work as before for a simple one-stop move; use **+ Add Stop** only when a route needs more than one stop.
- Existing moves saved before this change have no `stops` array. They keep displaying and working exactly as they did, and the Field App shows their single destination as a one-stop route.

For an already-linked CLI project, run `netlify deploy --build --prod` from this folder. Dragging only HTML/public into Netlify does NOT deploy the backend functions.

## Included fixes

- Version checks reject stale edits; request IDs make repeated state requests safe.
- Crew additions/removals do not overwrite unrelated data. Time/detail saves do not overwrite crew.
- Daily reset clears schedules, crew/drivers and vehicles on the server. Empty values remain empty.
- Active vehicle ownership is checked across moves.
- Shared state refreshes every 15 seconds while visible and not editing, without calling Make. Use Refresh to discover new GHL opportunities.
- Job schedule updates go directly to GHL; failures preserve dispatch state and show Retry.
- Existing worker/driver notifications, driver logs, and GHL creation/detail/stage workflows remain in Make.
- Roster reads share a five-minute server cache. Optional `ROSTER_CACHE_SECONDS` changes this, minimum 30 seconds.
- Job/container creation seeds shared state server-side. Retrying a confirmed request does not create a duplicate opportunity. Unconfirmed external calls require checking Make history.
- Database migrations preserve existing records. Only public HTML is exposed as static content.

## Existing records

Keep the original site/database. If some records exist ONLY in Make Data Stores, import those missing records before disabling their state workflows. Optional import templates are included and refuse to overwrite existing Netlify records.

Keep your existing dashboard access protection. Same-origin checks are not a user login system.

## Validation

22 automated tests passed, including PostgreSQL transaction tests. Build/syntax checks passed. An earlier headless Chrome smoke check had no page errors. Full two-browser tests were not completed; live Netlify/GHL behavior and Make blueprint imports have not been verified against your accounts.
