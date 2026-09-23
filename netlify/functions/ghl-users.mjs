import { json, errorResponse } from '../../lib/http.mjs';
import { listLocationUsers } from '../../lib/ghl.mjs';
// GHL location users for the Book Job "Assigned User" selector.
export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return json({ ok: true, users: await listLocationUsers() }, 200, { 'cache-control': 'private, max-age=300' });
  } catch (error) { console.error('GHL users lookup failed', error); return json({ ok: false, users: [], error: 'Could not load GHL users' }, 502); }
}
