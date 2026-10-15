// Scheduled: the afternoon reminders (see lib/logistics-reminder.mjs), one run
// for logistics moves and one for labor jobs, both to the reminder webhook.
// Netlify cron is UTC, so it runs at 22:00 and 23:00 UTC and only the run that
// lands on 3pm Pacific sends (22:00 in summer, 23:00 in winter). Once a day each.
import { db, ensureSchema } from './db.mjs';
import { runAllReminders } from '../../lib/logistics-reminder.mjs';
export default async function handler() {
  const sql = db(); await ensureSchema(sql);
  const { logistics, labor } = await runAllReminders(sql);
  console.log('Reminders', JSON.stringify({ logistics: logistics.sent || logistics.reason, labor: labor.sent || labor.reason }));
  return new Response(null, { status: 204 });
}
export const config = { schedule: '0 22,23 * * *' };
