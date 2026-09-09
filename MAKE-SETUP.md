# Make: two small changes

Keep your existing notification and driver-log action modules. No new everyday scenarios are required.

## 1. Confirm finished actions

At the END of each successful worker assign/remove, driver assign/remove, job edit/stage, container edit/stage and driver-log route, use **Webhooks → Webhook response**:

- Status: `200`
- Body: `{"ok":true}`
- Header: `Content-Type` = `application/json`

`make-blueprints/01-confirm-finished.json` contains that single response module. Import it into a temporary blank scenario, copy the module, and paste it LAST on your existing successful routes. Replace an existing response rather than adding another. Do not activate the temporary scenario: it contains no notification/log actions.

Never return success before the actual work finishes or from an error/ignore route. Plain `Accepted` means queued, not confirmed; the dashboard will flag it.

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

## Optional imports — skip if Netlify already has your records

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
