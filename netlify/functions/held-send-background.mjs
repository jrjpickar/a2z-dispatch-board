// Timer for one held send (the undo window on Completed / Cancelled).
// Started by /api/workflow-effect when a held send is recorded. Waits until the
// row's due_at, then sends everything that is due (this row, plus anything else
// a closed board left behind). Undo before then cancels the row, so nothing goes.
//
// Replaces the old effect-dispatcher cron (every 5 minutes, all day), which kept
// the Netlify database from ever going to sleep. The wait here touches nothing:
// the database is only used for one read before and the send after.
import { db, ensureSchema } from './db.mjs';
import { sendHeldEffects, heldSendKey, MAX_HOLD_MS } from '../../lib/effect-queue.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export default async function handler(request) {
  let effectId = '';
  try { effectId = String((await request.json()).effectId || '').slice(0, 240); } catch {}
  if (!effectId || request.headers.get('x-held-key') !== heldSendKey(effectId)) return new Response('Forbidden', { status: 403 });
  const sql = db(); await ensureSchema(sql);
  const [row] = await sql`select status, due_at from dispatch_effects where effect_id = ${effectId}`;
  if (!row || row.status !== 'scheduled') return new Response(null, { status: 202 }); // already sent or undone
  const wait = Math.min(MAX_HOLD_MS + 5000, Math.max(0, new Date(row.due_at).getTime() - Date.now() + 1000));
  await sleep(wait);
  const result = await sendHeldEffects(sql, { timeoutMs: 25000 });
  if (result.claimed.length) console.log('Held sends', JSON.stringify(result));
  return new Response(null, { status: 202 });
}
