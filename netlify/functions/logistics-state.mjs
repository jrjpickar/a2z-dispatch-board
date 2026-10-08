import { db, ensureSchema } from './db.mjs';
import { authorizeWrite, readPayload, json, errorResponse } from '../../lib/http.mjs';
import { moveRecord, saveState } from '../../lib/store.mjs';
export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      // ?since=<serverTime from the last answer>: only moves changed after it.
      const raw = new URL(request.url).searchParams.get('since');
      const t = raw ? Date.parse(raw) : NaN;
      const since = Number.isFinite(t) ? new Date(t - 5000) : null;
      const [rows, [{ now }]] = await Promise.all([
        since ? sql`select * from logistics_move_state where updated_at > ${since} order by updated_at desc`
              : sql`select * from logistics_move_state order by updated_at desc`,
        sql`select now() as now`
      ]);
      return json({ states: rows.map(moveRecord), serverTime: new Date(now).toISOString(), partial: !!since });
    }
    return json(await saveState(sql, 'move', await readPayload(request)));
  } catch (error) { return errorResponse(error); }
}
