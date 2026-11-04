// The 12 hour timer for held crew runs (lib/daily-dispatch.mjs), built so the database can sleep.
//
// The next due time is kept in Netlify Blobs (no database). A scheduled function
// (netlify/functions/nightly-dispatch.mjs) runs every 5 minutes and only reads that blob.
// When something is due within the next 6 minutes it starts the background runner
// (nightly-dispatch-background.mjs), which waits until the exact moment, sends, works out
// the next due time and saves it back to the blob. The database is only touched when
// something is actually going out, or when dispatch changes the crew or a job's times.
import { createHmac } from 'node:crypto';
import { nextDueAt } from './daily-dispatch.mjs';

export const CRON_EVERY_MS = 5 * 60e3;
export const START_WINDOW_MS = 6 * 60e3; // a little more than the cron gap
const KEY = 'next';
let storeOverride; // tests
export function setTimerStore(store) { storeOverride = store; }
async function store() {
  if (storeOverride) return storeOverride;
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'crew-hold', consistency: 'strong' });
}
// undefined: the blob store could not be read. null: nothing saved yet.
export async function readTimer() {
  try { return (await (await store()).get(KEY, { type: 'json' })) ?? null; }
  catch (error) { console.error('Crew hold timer: blob read failed', error.message); return undefined; }
}
export async function writeTimer(value) {
  try { await (await store()).setJSON(KEY, value); return true; }
  catch (error) { console.error('Crew hold timer: blob write failed', error.message); return false; }
}

export const runnerKey = due => createHmac('sha256', process.env.SESSION_SECRET || process.env.GHL_API_TOKEN || 'a2z-dispatch').update(`crew-hold:${due}`).digest('hex');
export async function startRunner(due) {
  const base = (process.env.URL || process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  if (!base) return false;
  try {
    const res = await fetch(`${base}/.netlify/functions/nightly-dispatch-background`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'x-hold-key': runnerKey(due) }, body: JSON.stringify({ due }) });
    return res.status === 202 || res.ok;
  } catch (error) { console.error('Crew hold runner not started', error.message); return false; }
}

// Works out the next due time from the database and saves it. Starts the runner when
// it is due within the window (or already past due).
export async function refreshTimer(sql, { now = Date.now() } = {}) {
  const nextDue = await nextDueAt(sql);
  const prev = await readTimer();
  const soon = nextDue != null && nextDue <= now + START_WINDOW_MS;
  const runnerFor = soon && prev?.runnerFor !== nextDue ? nextDue : (prev?.runnerFor ?? null);
  await writeTimer({ nextDue, runnerFor, checkedAt: now });
  if (soon && prev?.runnerFor !== nextDue) await startRunner(nextDue);
  return nextDue;
}

// The every-5-minutes check. Reads only the blob unless it is missing, unreadable or old.
export async function cronTick({ now = Date.now(), getSql } = {}) {
  const t = await readTimer();
  const stale = !t || now - (t.checkedAt || 0) > 6 * 3600e3; // a database check at least every 6 hours
  if (t === undefined || stale) {
    const sql = await getSql();
    await refreshTimer(sql, { now });
    return { checked: 'database' };
  }
  if (t.nextDue != null && t.nextDue <= now + START_WINDOW_MS && t.runnerFor !== t.nextDue) {
    await writeTimer({ ...t, runnerFor: t.nextDue });
    await startRunner(t.nextDue);
    return { checked: 'blob', started: t.nextDue };
  }
  return { checked: 'blob' };
}
