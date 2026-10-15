// POST /api/logistics-reminder-now  (admins): send tomorrow's Logistics reminder
// right away, e.g. to test the Make scenario. Skips the 3pm check and the once a
// day guard, but still sends nothing when every move for tomorrow is ready.
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, errorResponse } from '../../lib/http.mjs';
import { requireAdmin } from '../../lib/session.mjs';
import { runLogisticsReminder } from '../../lib/logistics-reminder.mjs';
export default async function handler(request) {
  try {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    await requireAdmin(request, sql);
    const result = await runLogisticsReminder(sql, { force: true, boardUrl: new URL(request.url).origin });
    return json({ ok: true, sent: result.sent, reason: result.reason || '', summary: result.payload?.summary || '' });
  } catch (error) { return errorResponse(error); }
}
