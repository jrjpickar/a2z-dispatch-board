// Safety net for held sends (undo window on Completed/Cancelled): sends anything
// whose window is over, even if no board is open anywhere.
//
// Runs every 5 minutes during work hours only, to save Netlify credits (it used
// to run every minute, 24/7: ~43,800 runs a month, then every 2 minutes ~15,300,
// now ~6,100). The board
// itself already sends at the end of the countdown, on Send now, and when the
// tab closes, so this only matters if a board vanishes mid-countdown. Outside
// these hours such a send goes out the next time any board with a waiting
// close polls, or when this job next runs.
//
// Netlify cron is UTC. 12:00-04:59 UTC = 5am-9:59pm Pacific in summer (PDT),
// 4am-8:59pm in winter (PST).
import { db, ensureSchema } from './db.mjs';
import { sendHeldEffects } from '../../lib/effect-queue.mjs';
export default async function handler() {
  const sql = db(); await ensureSchema(sql);
  const result = await sendHeldEffects(sql, { timeoutMs: 25000 });
  if (result.claimed.length) console.log('Held sends', JSON.stringify(result));
  return new Response(null, { status: 204 });
}
export const config = { schedule: '*/5 0-4,12-23 * * *' };
