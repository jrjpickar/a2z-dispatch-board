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

export async function ensureSchema(sql) {
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
}
