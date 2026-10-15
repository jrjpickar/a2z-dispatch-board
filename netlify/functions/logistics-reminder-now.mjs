// POST /api/logistics-reminder-now  (admins): send tomorrow's reminders (logistics
// and labor, one run each) right away, e.g. to test the Make scenario. Skips the
// 3pm check and the once a day guard, but a side with nothing missing sends nothing.
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, errorResponse } from '../../lib/http.mjs';
import { requireAdmin } from '../../lib/session.mjs';
import { runAllReminders } from '../../lib/logistics-reminder.mjs';
export default async function handler(request) {
  try {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    await requireAdmin(request, sql);
    const { logistics, labor } = await runAllReminders(sql, { force: true, boardUrl: new URL(request.url).origin });
    const line = r => r.sent ? r.payload.summary : r.reason === 'everything for tomorrow is ready' ? (r.payload?.summary || 'nothing missing') : `not confirmed by Make (${r.payload?.summary || ''})`;
    return json({ ok: true, sent: !!(logistics.sent || labor.sent), logistics: { sent: logistics.sent, reason: logistics.reason || '' }, labor: { sent: labor.sent, reason: labor.reason || '' },
      summary: `Logistics: ${line(logistics)} Labor: ${line(labor)}`, reason: !logistics.sent && !labor.sent && logistics.reason === labor.reason ? logistics.reason : '' });
  } catch (error) { return errorResponse(error); }
}
