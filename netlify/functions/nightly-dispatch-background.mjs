// Crew hold runner (background function, up to 15 minutes). File name kept from the old
// 6:30 PM run. Started by the 5 minute check or right after a dispatch change, with a key
// for the due time. Waits until that moment, sends every job whose 12 hours have been
// reached (one job every 15 seconds if several are due together), then works out the next
// due time and keeps going if it falls inside this run.
import { db, ensureSchema } from './db.mjs';
import { runDue, ensureHoldTables, nextDueAt } from '../../lib/daily-dispatch.mjs';
import { runnerKey, readTimer, writeTimer, startRunner, START_WINDOW_MS } from '../../lib/hold-timer.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BUDGET_MS = 14 * 60e3;
export default async function handler(request) {
  let due = NaN;
  try { due = Number((await request.json()).due); } catch {}
  if (!Number.isFinite(due) || request.headers.get('x-hold-key') !== runnerKey(due)) return new Response('Forbidden', { status: 403 });
  const deadline = Date.now() + BUDGET_MS;
  // Heartbeat: the 5 minute check restarts a runner that goes quiet past its due time.
  const beat = async () => { const t = await readTimer(); if (t) await writeTimer({ ...t, heartbeat: Date.now() }); };
  let target = due;
  try {
    const sql = db(); await ensureSchema(sql); await ensureHoldTables(sql);
    for (;;) {
      const wait = target - Date.now();
      if (wait > 0) await sleep(wait);
      await beat();
      const sent = await runDue(sql, { deadline: deadline - 30e3, onJob: beat });
      const next = await nextDueAt(sql);
      const now = Date.now();
      if (next != null && next <= now + 1000) {
        // Still due: either more jobs than fit in this run, or a send hit an error.
        const errored = sent.some(r => r.error);
        const started = !errored && await startRunner(next);
        await writeTimer({ nextDue: next, runnerFor: started ? next : null, checkedAt: now, heartbeat: now, restartAt: now }); // not started: the 5 minute check tries again
        break;
      }
      if (next != null && next < deadline - 60e3) { await writeTimer({ nextDue: next, runnerFor: next, checkedAt: now, heartbeat: now }); target = next; continue; }
      if (next != null && next <= now + START_WINDOW_MS) { const started = await startRunner(next); await writeTimer({ nextDue: next, runnerFor: started ? next : null, checkedAt: now, heartbeat: now, restartAt: now }); break; }
      await writeTimer({ nextDue: next, runnerFor: null, checkedAt: now, heartbeat: now });
      break;
    }
  } catch (error) {
    // Never leave the timer pointing at a runner that died: checkedAt 0 makes the next
    // 5 minute check go to the database and start a new one.
    console.error('Crew hold runner failed', error);
    await writeTimer({ nextDue: target, runnerFor: null, checkedAt: 0, heartbeat: Date.now() });
  }
  return new Response(null, { status: 202 });
}
