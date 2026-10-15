// Scheduled: the afternoon Logistics reminder (see lib/logistics-reminder.mjs).
// Netlify cron is UTC, so it runs at 22:00 and 23:00 UTC and only the run that
// lands on 3pm Pacific sends (22:00 in summer, 23:00 in winter). Once a day.
import { db, ensureSchema } from './db.mjs';
import { runLogisticsReminder } from '../../lib/logistics-reminder.mjs';
export default async function handler() {
  const sql = db(); await ensureSchema(sql);
  const result = await runLogisticsReminder(sql);
  console.log('Logistics reminder', JSON.stringify({ sent: result.sent, reason: result.reason || '', needs: result.payload?.needsAttention ?? null }));
  return new Response(null, { status: 204 });
}
export const config = { schedule: '0 22,23 * * *' };
