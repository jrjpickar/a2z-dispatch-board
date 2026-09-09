import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { createDispatch } from '../../lib/create.mjs';
export default async function handler(request) {
  try {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    authorizeWrite(request);
    const payload = await readPayload(request);
    const sql = db(); await ensureSchema(sql);
    return json(await createDispatch(sql, 'job', payload));
  } catch (error) { return errorResponse(error); }
}
