# A2Z Dispatch 1.2

Read START-HERE.md for deployment and MAKE-SETUP.md for the two Make response changes.

- `npm run build`: validates browser/functions/blueprints/driver app and produces public/index.html and public/driver/.
- `npm test`: mutation and PostgreSQL integration tests.
- Deploy this complete project to the existing Netlify site and database.

Includes the backend, edited dashboard, the read-only Field App for drivers/crew, tests, dependency lockfile, and minimal Make JSON templates. Credentials and production site linkage are not included.

## What's new in 1.2

- **Multi-stop routes.** A logistics move can now carry an ordered list of stops (address, type, date/time window, notes) instead of just one pickup and one destination. Add stops from the "Book Standalone Container" and "Edit" sheets on the Logistics tab. Older single-address moves keep working unchanged.
- **Field App** — a read-only mobile web app for drivers and crew at `/driver/` (installable to the home screen). Drivers see their assigned route's stops (in order) and can check a stop off as complete; nothing else is editable. Crew members see the labor job they're on and who else is on that crew. Everything else about a job or move (schedule, pricing, client details, assignment) stays dispatcher-only.
- Generate each person's sign-in code from the new "Field App Access" panel on the Logistics tab (pulls from the existing Driver and Labor rosters). Give them the `/driver/` link plus their phone number and code — that's their whole onboarding.
