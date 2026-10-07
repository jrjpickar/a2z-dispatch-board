// Safety net for held sends (undo window on Completed/Cancelled): every minute,
// send anything whose window is over, even if no board is open anywhere.
import { db, ensureSchema } from './db.mjs';
import { sendHeldEffects } from '../../lib/effect-queue.mjs';
export default async function handler() {
  const sql = db(); await ensureSchema(sql);
  const result = await sendHeldEffects(sql, { timeoutMs: 25000 });
  if (result.claimed.length) console.log('Held sends', JSON.stringify(result));
  return new Response(null, { status: 204 });
}
export const config = { schedule: '* * * * *' };
