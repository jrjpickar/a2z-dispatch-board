// Board defaults every browser uses (set by a senior admin): GET /api/settings
import { db, ensureSchema } from './db.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { publicSettings } from '../../lib/settings.mjs';
export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const sql = db(); await ensureSchema(sql);
    return json(await publicSettings(sql));
  } catch (error) { return errorResponse(error); }
}
