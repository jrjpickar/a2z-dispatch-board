# A2Z Dispatch — Netlify backend

This package moves the high-frequency dashboard read and shared-state writes from Make to Netlify Functions and Netlify Database.

## What is automatic

- Netlify detects and deploys both Functions.
- Importing `@netlify/database` enables Netlify Database provisioning on a credit-based Netlify plan.
- The `job_shared_state` table and index are created automatically the first time either Function runs.
- The dashboard already points to `/api/dashboard-data` and `/api/shared-state`.
- Non-secret pipeline and location defaults are included.

## One required manual step

In Netlify, open **Project configuration → Environment variables** and add:

- `GHL_API_TOKEN` — required; use a newly rotated GHL private integration token.
- `GHL_LOCATION_ID` — optional because the current value is included as a default.
- `LABOR_PIPELINE_ID` — optional because the current value is included as a default.
- `DEMO_PIPELINE_ID` — optional because the current value is included as a default.

Secret values are intentionally not stored in this deploy package.

## Deploy

The reliable path is to put this folder in a Git repository and connect that repository to Netlify. Netlify will run `npm run build`, install the dependencies, provision the database integration, and deploy the Functions.

For an existing Netlify project, deploy this folder through the Netlify CLI instead of dragging only `index.html` into the manual deploy area.

## Migration warning

Netlify Database starts empty. Before disabling the Make Data Store, copy the existing active shared-state records into the new endpoint or run both systems briefly while testing. Once the records are present and `/api/dashboard-data` returns the expected jobs and shared state, disable the `GHL Opps to DD` Make scenario.

The same-origin check on `/api/shared-state` is a basic safeguard, not full user authentication. Add Netlify Identity or another login layer before exposing the dashboard publicly.
