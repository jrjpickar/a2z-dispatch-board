# Employee hours and dashboard loading update

Merge the contents of this ZIP into the existing repository root, preserving the
included paths. It contains changed files only, not a complete standalone site.
Commit and deploy through your existing Netlify build. No new dependencies,
database migrations or environment variables are required. The original source
ZIP has not been changed.

## Employee hours

The EOD job-log request now uses the submitted EOD crew list, including workers
sent home early. Each assignedWorkers entry includes workerName, workerPhone,
contactId, numeric hoursWorked and sentHome. The top-level hoursWorked is the sum
of those individual values. Zero hours remain zero; missing/invalid hours are
rejected by the payload builder. There is no fixed employee-slot limit in this
payload builder. Existing EOD input and saved-summary limits are unchanged.

Completed queues only the GHL stage update and keeps its existing Undo window.
The accounting log is sent with EOD, so Completed no longer sends a second empty
log after the crew has been reset. Cancelling retains its existing stage behavior.

Use the updated Make employee iterator and V5 repeating-row Word template from
the earlier update. Refresh the Make webhook data structure with a new EOD
request so assignedWorkers[].hoursWorked is available to the iterator. The
scenario must route job logs for action eod_sheet. A crew with no employees
produces no employee bundles in the previously supplied Make iterator.

## Loading and resource use

- Jobs display immediately when their response arrives, without the previous
  wait of up to 1.5 seconds for the roster. The roster fills in afterward.
- Refresh remains disabled while its requested reads are running, avoiding
  repeated requests from rapid clicks. It is re-enabled even if a read fails.
- Admin Refresh no longer requests the driver roster twice.
- Simultaneous project-schedule reads share one pending request; a later read
  still reloads normally.
- Simultaneous ordinary dashboard feed reads on the same warm function instance
  share one pending GHL cache read/fill. The existing shared Postgres cache and
  60-second default remain. Explicit fresh reads after saves remain independent.
- Existing live-update intervals, hidden-tab behavior, scheduled dispatch and
  document generation are unchanged. No private dashboard responses are added
  to a public CDN cache.

These changes remove redundant work; actual Netlify credit savings depend on
traffic, concurrent usage and your account's metering. No billing measurements
or live production changes were made.

## Validation

75 targeted automated tests passed, covering the new payload, large crews,
missing hours, completion behavior, loading, caching, state and related flows.
The repository build/syntax checks passed. Local browser checks passed for EOD
individual hours (including sent-home employees), completion without duplicate
logs, and completion Undo/Send now/tab-close behavior. Browser tests use mocked
services and do not send live webhooks.

Database-dependent integration tests requiring unavailable project dependencies
were not run. The updated cache helper has dependency-free concurrency/cache
unit coverage. A live Make run and production Netlify billing were not tested.
