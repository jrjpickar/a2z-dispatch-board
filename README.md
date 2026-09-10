# A2Z Dispatch 1.3

Read START-HERE.md for deployment and MAKE-SETUP.md for the two Make response changes.

- `npm run build`: validates browser/functions/blueprints/driver app and produces public/index.html and public/driver/.
- `npm test`: mutation and PostgreSQL integration tests.
- Deploy this complete project to the existing Netlify site and database.

Includes the backend, edited dashboard, the read-only Field App for drivers/crew, tests, dependency lockfile, and minimal Make JSON templates. Credentials and production site linkage are not included.

## What's new in 1.3

- **Phone-only sign-in for the Field App.** No more access codes to hand out or type. A dispatcher enables a person once (Field App Access panel), and from then on they just enter their phone number.
- **Spanish/English toggle in the Field App.** An EN/ES switch in the top bar translates the sign-in screen and every route/job/stop label. The choice is remembered on that phone.

## What's new in 1.2

- **Multi-stop routes.** A logistics move can now carry an ordered list of stops (address, type, date/time window, notes) instead of just one pickup and one destination. Add stops from the "Book Standalone Container" and "Edit" sheets on the Logistics tab. Older single-address moves keep working unchanged.
- **Field App** — a read-only mobile web app for drivers and crew at `/driver/` (installable to the home screen). Drivers see their assigned route's stops (in order) and can check a stop off as complete; nothing else is editable. Crew members see the labor job they're on and who else is on that crew. Everything else about a job or move (schedule, pricing, client details, assignment) stays dispatcher-only.
- Turn on access for each person from the "Field App Access" panel on the Logistics tab (pulls from the existing Driver and Labor rosters). Give them the `/driver/` link — they sign in with just their phone number, no code to remember.
