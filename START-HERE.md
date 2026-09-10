# Deploy A2Z Dispatch 1.3

1. Replace the files in your existing Netlify-connected repository with this folder’s contents. Keep the SAME Netlify site and database.
2. Keep `GHL_API_TOKEN` in Netlify environment variables. Netlify Database supplies `NETLIFY_DB_URL`; never paste it into the page.
3. **Add a new environment variable: `DRIVER_TOKEN_SECRET`.** This signs the Field App's driver/crew sign-in tokens. Set it to any long random string (e.g. `openssl rand -hex 32`) and never reuse it elsewhere. The build/deploy will still succeed without it, but the Field App's sign-in and route/job endpoints will return a 500 until it's set.
4. Apply the two small Make response changes in MAKE-SETUP.md.
5. Deploy normally. Build: `npm run build`. Publish: `public`. Functions: `netlify/functions`. Node: 22 or newer.
6. Reload all open dashboard tabs after deployment. Old tabs cannot overwrite new state.

## Field App (read-only, for drivers and crew)

- Lives at `/driver/` on the same site — no separate deployment, app store, or hosting needed. Give someone the link and tell them to "Add to Home Screen" for an app-like icon.
- On the Logistics tab, open the **Field App Access** panel and click **Enable** next to a driver or crew member's name (pulled from the existing Driver and Labor rosters). Give them the `/driver/` link — they sign in with just their phone number, nothing else to hand out. **Revoke** removes their access; **Enable** again to restore it.
- Sign-in is phone-number-only, by design, so it's low-friction for the crew. That also means anyone who knows an enabled person's phone number could open their route/job if they had the link — reasonable for an internal crew, but worth knowing. Revoke access as soon as someone leaves.
- A driver sees only the logistics moves assigned to them (matched by phone, or name if no phone is on file), in stop order, and can tap a stop to mark it done/not done — nothing else on the board is reachable from there.
- A crew member sees only the labor job(s) they're on the crew for, and the names of their coworkers on that job — no pricing, client contact details beyond what's already shown, or other jobs.
- Who's enabled is stored in the database (`dispatch_driver_codes` — the name is legacy, there's no code in it anymore), not in Make/GHL. There's no separate "employee" system to keep in sync — it just matches whatever name/phone is already on the job or move.
- An **EN/ES** switch in the Field App's top bar translates the sign-in screen and every route/job/stop label. It defaults to the phone's own language and remembers whatever the person picks.

## Multi-stop routes

- A move's `stops` field (set from the Logistics "Book Standalone Container" / "Edit" sheets) is now the source of truth for its route when present. The single Pickup/Delivery Address fields still work as before for a simple one-stop move; use **+ Add Stop** only when a route needs more than one stop.
- Existing moves saved before this change have no `stops` array — they keep displaying and working exactly as they did, and the Field App shows their single destination as a one-stop route.

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
