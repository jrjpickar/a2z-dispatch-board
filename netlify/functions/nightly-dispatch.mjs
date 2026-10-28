// 6:30 PM Pacific trigger for the daily dispatch (lib/daily-dispatch.mjs).
// Netlify cron is UTC, so it fires at 01:30 UTC (6:30 PM Pacific in summer) and
// 02:30 UTC (6:30 PM in winter) and only acts between 6:30 and 7:59 PM Pacific. The day's run is
// claimed once, then handed to nightly-dispatch-background, which can run for up to
// 15 minutes (one batch of workers every 15 seconds).
import { createHmac } from 'node:crypto';
import { db, ensureSchema } from './db.mjs';
import { pacificParts, claimNightly } from '../../lib/daily-dispatch.mjs';
export const nightlyKey = date => createHmac('sha256', process.env.SESSION_SECRET || process.env.GHL_API_TOKEN || 'a2z-dispatch').update(`nightly:${date}`).digest('hex');
export default async function handler() {
  const { date, hour, minute } = pacificParts();
  const minutes = hour * 60 + minute;
  if (minutes < 18 * 60 + 30 || minutes >= 20 * 60) return new Response(null, { status: 204 });
  const sql = db(); await ensureSchema(sql);
  if (!(await claimNightly(sql, date))) return new Response(null, { status: 204 }); // already ran today
  const base = (process.env.URL || process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  const res = await fetch(`${base}/.netlify/functions/nightly-dispatch-background`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nightly-key': nightlyKey(date) }, body: JSON.stringify({ date }) });
  console.log('Nightly dispatch started', date, res.status);
  return new Response(null, { status: 204 });
}
export const config = { schedule: '30 1,2 * * *' };
