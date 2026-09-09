import { db, ensureSchema } from './db.mjs';
import { authorizeWrite, readPayload, json, errorResponse } from '../../lib/http.mjs';
import { syncJobSchedule } from '../../lib/ghl.mjs';
import { StateError } from '../../lib/state.mjs';
export default async function handler(request) {
  try {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    authorizeWrite(request);
    const { jobId } = await readPayload(request);
    if (!jobId || typeof jobId !== 'string') throw new StateError('jobId required');
    const sql = db(); await ensureSchema(sql);
    const result = await syncJobSchedule(sql, jobId);
    return json(result, result.ok ? 200 : 502);
  } catch (error) { return errorResponse(error); }
}
