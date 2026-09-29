// Admin-only GHL contact search: GET /api/ghl-contacts?q=<name, phone or email>
import { db, ensureSchema } from './db.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { requireAdmin } from '../../lib/session.mjs';
import { searchContacts } from '../../lib/ghl.mjs';
export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const sql = db(); await ensureSchema(sql);
    await requireAdmin(request, sql);
    const q = new URL(request.url).searchParams.get('q') || '';
    try { return json({ ok: true, contacts: await searchContacts(q) }); }
    catch (error) { console.error('GHL contact search failed', error); return json({ ok: false, contacts: [], error: 'GHL contact search failed. The token needs contacts.readonly.' }, 502); }
  } catch (error) { return errorResponse(error); }
}
