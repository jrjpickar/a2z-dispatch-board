// Read-only data feed for the A2Z KPI dashboard (a separate Netlify site).
//   GET /api/metrics-export      header x-metrics-key: <METRICS_EXPORT_KEY>
// Returns the dispatch state the dashboard needs: jobs, logistics moves, the
// day-by-day crew log (job_day_log, plus older days rebuilt from the job log
// payloads kept on Make runs since 1.8), who booked what on the board, EOD
// sheet totals, the worker/driver/vehicle rosters and Make run health.
// Nothing is written. Without METRICS_EXPORT_KEY set the feed is off (503).
import { db, ensureSchema } from './db.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { secretMatches } from '../../lib/session.mjs';
import { buildExport } from '../../lib/metrics-export.mjs';

export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    const expected = process.env.METRICS_EXPORT_KEY || '';
    if (!expected) return json({ error: 'METRICS_EXPORT_KEY is not set on the dispatch site, so the KPI feed is off.' }, 503);
    const supplied = request.headers.get('x-metrics-key') || (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!secretMatches(supplied, expected)) return json({ error: 'Invalid metrics key' }, 401);
    const sql = db(); await ensureSchema(sql);
    return json(await buildExport(sql));
  } catch (error) { return errorResponse(error); }
}
