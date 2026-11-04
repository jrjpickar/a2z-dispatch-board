// Crew hold runner (background function, up to 15 minutes). File name kept from the old
// 6:30 PM run. Started by the 5 minute check or right after a dispatch change, with a key
// for the due time. Waits until that moment, sends every job whose 12 hours have been
// reached (one job every 15 seconds if several are due together), then works out the next
// due time and keeps going if it falls inside this run.
import { db, ensureSchema } from './db.mjs';
import { runDue, ensureHoldTables, nextDueAt } from '../../lib/daily-dispatch.mjs';
import { runnerKey, writeTimer, startRunner, START_WINDOW_MS } from '../../lib/hold-timer.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BUDGET_MS = 14 * 60e3;
export default async function handler(request) {
  let due = NaN;
  try { due = Number((await request.json()).due); } catch {}
  if (!Number.isFinite(due) || request.headers.get('x-hold-key') !== runnerKey(due)) return new Response('Forbidden', { status: 403 });
  const deadline = Date.now() + BUDGET_MS;
  const sql = db(); await ensureSchema(sql); await ensureHoldTables(sql);
  let target = due;
  for (;;) {
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
    const sent = await runDue(sql, { deadline: deadline - 30e3 });
    const next = await nextDueAt(sql);
    const now = Date.now();
    if (next != null && next <= now + 1000) {
      // Still due: either more jobs than fit in this run, or a send hit an error.
      const errored = sent.some(r => r.error);
      await writeTimer({ nextDue: next, runnerFor: errored ? null : next, checkedAt: now }); // error: the 5 minute check tries again
      if (!errored) await startRunner(next);
      break;
    }
    if (next != null && next < deadline - 60e3) { await writeTimer({ nextDue: next, runnerFor: next, checkedAt: now }); target = next; continue; }
    if (next != null && next <= now + START_WINDOW_MS) { await writeTimer({ nextDue: next, runnerFor: next, checkedAt: now }); await startRunner(next); break; }
    await writeTimer({ nextDue: next, runnerFor: null, checkedAt: now });
    break;
  }
  return new Response(null, { status: 202 });
}
