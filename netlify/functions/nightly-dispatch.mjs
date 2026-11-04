// Crew hold timer check, every 5 minutes (lib/hold-timer.mjs). File name kept from the
// old 6:30 PM run. It reads one small Netlify Blob and does nothing else unless a held
// crew run is due within 6 minutes, so the database keeps sleeping. Every 6 hours (or if
// the blob can't be read) it checks the database instead, and sweeps any Completed /
// Cancelled send whose own timer never ran.
import { db, ensureSchema } from './db.mjs';
import { cronTick } from '../../lib/hold-timer.mjs';
import { ensureHoldTables } from '../../lib/daily-dispatch.mjs';
import { sendHeldEffects } from '../../lib/effect-queue.mjs';
export default async function handler() {
  try {
    const result = await cronTick({ getSql: async () => {
      const sql = db(); await ensureSchema(sql); await ensureHoldTables(sql);
      try { await sendHeldEffects(sql, { timeoutMs: 25000 }); } catch (error) { console.error('Held send sweep failed', error); }
      return sql;
    } });
    if (result.checked !== 'blob' || result.started) console.log('Crew hold timer', JSON.stringify(result));
  } catch (error) { console.error('Crew hold timer failed', error); }
  return new Response(null, { status: 204 });
}
export const config = { schedule: '*/5 * * * *' };
