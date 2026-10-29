import { getConnectionString } from "@netlify/database";
import postgres from "postgres";
import { createHash } from "node:crypto";

let client;

export function db() {
  if (!client) {
    client = postgres(getConnectionString(), {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10
    });
  }
  return client;
}

// Schema setup, cheap on cold starts (saves Netlify compute):
// every function used to run the whole create/alter list below on its first
// call. Now one quick read checks the stored schema version and the full list
// only runs when createSchema itself has changed. The version is a hash of
// createSchema's own source, so editing it (new table, new column, new
// migration) automatically triggers one full run on the next deploy -- no
// version number to remember to bump.
const SCHEMA_VERSION_KEY = 'schema:version';
let schemaVersion;
const currentSchemaVersion = () => schemaVersion ||= createHash('sha256').update(createSchema.toString()).digest('hex').slice(0, 16);
let schemaReady;
export function ensureSchema(sql) {
  if (!schemaReady) schemaReady = checkOrCreateSchema(sql).catch(error => { schemaReady = undefined; throw error; });
  return schemaReady;
}
async function checkOrCreateSchema(sql) {
  try {
    const [row] = await sql`select value from dispatch_settings where key = ${SCHEMA_VERSION_KEY}`;
    const version = currentSchemaVersion();
    if (row && (row.value === version || row.value === JSON.stringify(version))) return;
  } catch { /* first run: dispatch_settings doesn't exist yet */ }
  await createSchema(sql);
  await sql`insert into dispatch_settings (key, value, updated_by) values (${SCHEMA_VERSION_KEY}, ${JSON.stringify(currentSchemaVersion())}::jsonb, 'deploy')
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
}
async function createSchema(sql) {
  await sql.begin(async sql => {
  await sql`select pg_advisory_xact_lock(824291001)`;
  await sql`create table if not exists logistics_documents (id text primary key, name text not null, mime_type text not null, content_base64 text not null, created_at timestamptz not null default now())`;
  await sql`
    create table if not exists job_shared_state (
      job_id text primary key,
      data jsonb not null default '{}'::jsonb,
      active boolean not null default true,
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create index if not exists job_shared_state_active_idx
    on job_shared_state (active)
  `;

  await sql`alter table job_shared_state add column if not exists version integer not null default 1`;
  await sql`create table if not exists logistics_move_state (
    move_id text primary key, data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(), version integer not null default 1
  )`;
  await sql`alter table logistics_move_state add column if not exists version integer not null default 1`;
  await sql`create table if not exists dispatch_requests (
    request_id text primary key, fingerprint text not null, result jsonb not null,
    created_at timestamptz not null default now()
  )`;
  await sql`create table if not exists dispatch_crm_sync (
    job_id text primary key, pending boolean not null default true, last_error text,
    updated_at timestamptz not null default now()
  )`;
  // Completed job log rows pushed from Make (POST /api/job-log), read by EOD Done.
  await sql`create table if not exists dispatch_job_log (
    row_key text primary key, day text not null, data jsonb not null, updated_at timestamptz not null default now()
  )`;
  await sql`create index if not exists dispatch_job_log_day on dispatch_job_log (day)`;
  // PDFs Make attaches to job log rows (EOD sheet / job costing PDF).
  await sql`create table if not exists dispatch_job_log_pdf (
    id text primary key, match_key text unique not null, job_id text not null default '', action text not null default '',
    day text not null default '', event_id text not null default '', name text not null, content_base64 text not null,
    updated_at timestamptz not null default now()
  )`;
  await sql`create index if not exists dispatch_job_log_pdf_day on dispatch_job_log_pdf (day)`;
  await sql`create table if not exists dispatch_roster_cache (
    kind text primary key, data jsonb not null, updated_at timestamptz not null default now()
  )`;
  // Short shared cache of the GHL job list for /api/dashboard-data (Refresh skips it).
  await sql`create table if not exists dispatch_feed_cache (
    key text primary key, data jsonb not null, updated_at timestamptz not null default now()
  )`;
  await sql`create table if not exists dispatch_effects (
    effect_id text primary key, request_id text not null, kind text not null,
    fingerprint text not null, status text not null, last_error text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  )`;
  await sql`create table if not exists dispatch_creations (
    request_id text primary key, kind text not null, fingerprint text not null, payload jsonb not null,
    status text not null, opportunity_id text, result jsonb, updated_at timestamptz not null default now()
  )`;
  // "Codes" in the name is legacy -- access is now just an enabled phone/name,
  // no code required (see driver-auth.mjs). Column kept, nullable, for anyone
  // still holding a pre-upgrade row; nothing reads it anymore.
  await sql`create table if not exists dispatch_driver_codes (
    driver_key text primary key, name text not null default '', phone text not null default '',
    code text, updated_at timestamptz not null default now()
  )`;
  await sql`alter table dispatch_driver_codes alter column code drop not null`;
  // Dashboard admins (the admin list on the board). Bootstrap admins from
  // BOOTSTRAP_ADMINS are added on their first sign-in.
  await sql`create table if not exists dispatch_admins (
    user_id text primary key, name text not null default '', email text not null default '',
    added_by text not null default '', created_at timestamptz not null default now()
  )`;
  // Workers an admin added by GHL contact search (not on the Make roster).
  // Merged into the crew and driver pickers and the Field App Access list.
  await sql`create table if not exists dispatch_manual_workers (
    contact_id text primary key, name text not null, phone text not null default '',
    email text not null default '', is_labor boolean not null default true, is_driver boolean not null default false,
    added_by text not null default '', created_at timestamptz not null default now()
  )`;
  // Workers (crew and/or drivers) an admin removed from the board. Hidden only
  // on the board; nothing changes in GHL or the Make rosters. Restorable.
  await sql`create table if not exists dispatch_hidden_workers (
    worker_key text primary key, role text not null default 'labor', name text not null default '',
    phone text not null default '', contact_id text not null default '', hidden_by text not null default '',
    created_at timestamptz not null default now()
  )`;
  // Each worker's GHL Temperature custom field, cached so the board doesn't hit
  // GHL for every worker on every load. Refreshed by /api/worker-temperatures.
  await sql`create table if not exists dispatch_worker_temperature (
    contact_id text primary key, value text not null default '', fetched_at timestamptz not null default now()
  )`;
  // Senior admin tools (1.8): activity log, send history, settings, and the
  // payload kept on each Make workflow so a failed one can be retried.
  await sql`create table if not exists dispatch_activity (
    id bigserial primary key, at timestamptz not null default now(), actor_id text not null default '',
    actor_name text not null default '', action text not null, target text not null default '', detail jsonb not null default '{}'::jsonb
  )`;
  await sql`create index if not exists dispatch_activity_at_idx on dispatch_activity (at desc)`;
  await sql`create table if not exists dispatch_send_log (
    id bigserial primary key, at timestamptz not null default now(), kind text not null, job_id text not null default '',
    job_name text not null default '', file_name text not null default '', status text not null, detail text not null default ''
  )`;
  await sql`create index if not exists dispatch_send_log_job_idx on dispatch_send_log (job_id, at desc)`;
  await sql`create table if not exists dispatch_settings (
    key text primary key, value jsonb not null, updated_by text not null default '', updated_at timestamptz not null default now()
  )`;
  await sql`alter table dispatch_effects add column if not exists payload jsonb`;
  // Held sends (undo window on Completed/Cancelled): status 'scheduled' until due_at, or 'cancelled' by Undo.
  await sql`alter table dispatch_effects add column if not exists due_at timestamptz`;
  // One-time (Jesse, 1.8): acknowledge every Make/GHL problem that existed before
  // this deploy so the senior admin problems list starts clean.
  const [acked] = await sql`select 1 as ok from dispatch_settings where key = 'migration:ack-problems-1.8'`;
  if (!acked) {
    await sql`update dispatch_effects set status = 'confirmed', last_error = 'Acknowledged when 1.8 was deployed', updated_at = now() where status <> 'confirmed'`;
    await sql`update dispatch_crm_sync set pending = false, last_error = 'Acknowledged when 1.8 was deployed', updated_at = now() where pending = true`;
    await sql`insert into dispatch_settings (key, value, updated_by) values ('migration:ack-problems-1.8', 'true'::jsonb, 'deploy') on conflict (key) do nothing`;
  }
  // KPI dashboard: one row per job per worked day, captured before Complete EOD
  // Sheet (reset_dispatch) or Completed clears the day's times and crew.
  await sql`create table if not exists job_day_log (
    job_id text not null, report_date text not null, data jsonb not null default '{}'::jsonb,
    source text not null default '', logged_at timestamptz not null default now(),
    primary key (job_id, report_date)
  )`;
  await sql`create index if not exists job_day_log_date_idx on job_day_log (report_date)`;
  // KPI dashboard: one row per logistics run (a move's day, closed by the
  // driver-log Reset day or by Complete), captured before the schedule,
  // driver and vehicles are cleared. Unschedule is not a run and isn't logged.
  await sql`create table if not exists move_run_log (
    move_id text not null, run_date text not null, movement_type text not null default '',
    data jsonb not null default '{}'::jsonb, source text not null default '', logged_at timestamptz not null default now(),
    primary key (move_id, run_date, movement_type)
  )`;
  // Project Schedules for Contract (Demo) jobs: the sheet's inputs, shared by
  // every dispatcher, plus when it was last sent to Make as a PDF.
  await sql`create table if not exists project_schedules (
    job_id text primary key, data jsonb not null default '{}'::jsonb,
    version integer not null default 1, sent_at timestamptz, sent_file text,
    updated_at timestamptz not null default now()
  )`;
  });
}
