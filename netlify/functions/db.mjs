import { getConnectionString } from "@netlify/database";
import postgres from "postgres";

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

let schemaReady;
export function ensureSchema(sql) {
  if (!schemaReady) schemaReady = createSchema(sql).catch(error => { schemaReady = undefined; throw error; });
  return schemaReady;
}
async function createSchema(sql) {
  await sql.begin(async sql => {
  await sql`select pg_advisory_xact_lock(824291001)`;
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
  await sql`create table if not exists dispatch_roster_cache (
    kind text primary key, data jsonb not null, updated_at timestamptz not null default now()
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
  await sql`create table if not exists dispatch_driver_codes (
    driver_key text primary key, name text not null default '', phone text not null default '',
    code text not null, updated_at timestamptz not null default now()
  )`;
  });
}
