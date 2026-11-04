import { json, errorResponse } from '../../lib/http.mjs';
import { listLocationUsers } from '../../lib/ghl.mjs';
import { requireSession } from '../../lib/session.mjs';
// GHL location users for the Book Job "Assigned User" selector and the Admin page.
// Signed-in sessions only: the user IDs in this list are the sign-in passwords outside GHL.
export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    try { await requireSession(request); } catch (error) { return json({ ok: false, users: [], error: error.status === 403 ? error.message : 'Sign in first.' }, error.status || 401); }
    return json({ ok: true, users: await listLocationUsers() }, 200, { 'cache-control': 'private, max-age=300' });
  } catch (error) { console.error('GHL users lookup failed', error); return json({ ok: false, users: [], error: 'Could not load GHL users' }, 502); }
}
