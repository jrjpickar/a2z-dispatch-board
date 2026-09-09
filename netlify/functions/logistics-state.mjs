import { db, ensureSchema } from './db.mjs';
import { authorizeWrite, readPayload, json, errorResponse } from '../../lib/http.mjs';
import { moveRecord, saveState } from '../../lib/store.mjs';
export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') return json({ states: (await sql`select * from logistics_move_state order by updated_at desc`).map(moveRecord) });
    return json(await saveState(sql, 'move', await readPayload(request)));
  } catch (error) { return errorResponse(error); }
}
