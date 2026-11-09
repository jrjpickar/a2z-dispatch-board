// The 12 hour timer for held crew runs (lib/daily-dispatch.mjs), built so the database can sleep.
//
// The next due time is kept in Netlify Blobs (no database). A scheduled function
// (netlify/functions/nightly-dispatch.mjs) runs every 5 minutes and only reads that blob.
// When something is due within the next 6 minutes it starts the background runner
// (nightly-dispatch-background.mjs), which waits until the exact moment, sends, works out
// the next due time and saves it back to the blob. The database is only touched when
// something is actually going out, or when dispatch changes the crew or a job's times.
import { createHmac } from 'node:crypto';
import { nextDueAt, owedTexts } from './daily-dispatch.mjs';

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
  if (!base) { console.error('Crew hold runner not started: URL / PUBLIC_APP_URL is not set'); return false; }
  try {
    const res = await fetch(`${base}/.netlify/functions/nightly-dispatch-background`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'x-hold-key': runnerKey(due) }, body: JSON.stringify({ due }) });
    if (res.status === 202 || res.ok) return true;
    console.error('Crew hold runner not started: HTTP', res.status);
    return false;
  } catch (error) { console.error('Crew hold runner not started', error.message); return false; }
}

// A runner was started for nextDue but has given no sign of life since that moment
// (it writes a heartbeat when it wakes and after each job). Before this check, a runner
// that never started or died left runnerFor set and nothing ever retried it.
export const STUCK_MS = 4 * 60e3;
export function isStuck(t, now = Date.now()) {
  if (!t || t.nextDue == null || t.runnerFor == null || t.runnerFor !== t.nextDue) return false;
  return now - Math.max(t.nextDue, t.heartbeat || 0) > STUCK_MS;
}
const RESTART_GAP_MS = 10 * 60e3;

// Works out the next due time from the database and saves it. Starts the runner when
// it is due within the window (or already past due). Texts owed after a cut off send
// (owedTexts) count as due now. runnerFor is only kept when the runner really started.
export async function refreshTimer(sql, { now = Date.now() } = {}) {
  const held = await nextDueAt(sql);
  let owed = false;
  try { owed = (await owedTexts(sql, { now })).length > 0; } catch (error) { console.error('Crew hold owed check failed', error.message); }
  const prev = await readTimer();
  // Owed texts only: one runner per 5 minutes is plenty.
  const owedOnly = owed && !(held != null && held <= now + START_WINDOW_MS);
  const nextDue = owed && !(owedOnly && now - (prev?.restartAt || 0) < 5 * 60e3) ? Math.min(held ?? Infinity, now) : held;
  const soon = nextDue != null && nextDue <= now + START_WINDOW_MS;
  const covered = prev?.runnerFor === nextDue && !isStuck(prev, now);
  let runnerFor = prev?.runnerFor ?? null, restartAt = prev?.restartAt || 0;
  if (soon && !covered) {
    const started = await startRunner(nextDue);
    runnerFor = started ? nextDue : null;
    restartAt = now;
  }
  await writeTimer({ nextDue, runnerFor, checkedAt: now, heartbeat: prev?.heartbeat || 0, restartAt });
  return nextDue;
}

// The every-5-minutes check. Reads only the blob unless it is missing, unreadable, old,
// or the runner for an overdue time never showed up (then the database is checked and
// the runner started again, at most once every 10 minutes).
export async function cronTick({ now = Date.now(), getSql } = {}) {
  const t = await readTimer();
  const stale = !t || now - (t.checkedAt || 0) > 6 * 3600e3; // a database check at least every 6 hours
  const stuck = !!t && isStuck(t, now) && now - (t.restartAt || 0) > RESTART_GAP_MS;
  if (t === undefined || stale || stuck) {
    if (stuck) console.error('Crew hold runner never finished for', new Date(t.nextDue).toISOString(), '- starting it again');
    const sql = await getSql();
    await refreshTimer(sql, { now });
    return { checked: 'database', ...(stuck ? { stuck: true } : {}) };
  }
  if (t.nextDue != null && t.nextDue <= now + START_WINDOW_MS && t.runnerFor !== t.nextDue) {
    const started = await startRunner(t.nextDue);
    await writeTimer({ ...t, runnerFor: started ? t.nextDue : null, restartAt: now });
    return { checked: 'blob', started: started ? t.nextDue : null, ...(started ? {} : { startFailed: true }) };
  }
  return { checked: 'blob' };
}
