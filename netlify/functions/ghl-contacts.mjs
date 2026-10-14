// GHL contact search.
//   GET /api/ghl-contacts?q=<name, phone or email>              (admins: Add laborer from GHL)
//   GET /api/ghl-contacts?q=<name, phone or email>&for=client   (any signed-in user: Book Job client search)
import { db, ensureSchema } from './db.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { requirePanel } from '../../lib/layout.mjs';
import { requireSession } from '../../lib/session.mjs';
import { searchContacts, clientSummary } from '../../lib/ghl.mjs';
export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const url = new URL(request.url);
    const forClient = url.searchParams.get('for') === 'client';
    const q = url.searchParams.get('q') || '';
    if (forClient) await requireSession(request);
    else { const sql = db(); await ensureSchema(sql); await requirePanel(request, sql, 'laborers'); }
    try { return json({ ok: true, contacts: await searchContacts(q, forClient ? 10 : 20, forClient ? clientSummary : undefined) }); }
    catch (error) { console.error('GHL contact search failed', error); return json({ ok: false, contacts: [], error: 'GHL contact search failed. The token needs contacts.readonly.' }, 502); }
  } catch (error) { return errorResponse(error); }
}
