# Deploy A2Z Dispatch 1.1

1. Replace the files in your existing Netlify-connected repository with this folder’s contents. Keep the SAME Netlify site and database.
2. Keep `GHL_API_TOKEN` in Netlify environment variables. Netlify Database supplies `NETLIFY_DB_URL`; never paste it into the page.
3. Apply the two small Make response changes in MAKE-SETUP.md.
4. Deploy normally. Build: `npm run build`. Publish: `public`. Functions: `netlify/functions`. Node: 22 or newer.
5. Reload all open dashboard tabs after deployment. Old tabs cannot overwrite new state.

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
