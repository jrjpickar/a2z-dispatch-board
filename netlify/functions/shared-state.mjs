import { db, ensureSchema } from './db.mjs';
import { authorizeWrite, readPayload, json, errorResponse } from '../../lib/http.mjs';
import { jobRecord, saveState } from '../../lib/store.mjs';
import { syncJobSchedule } from '../../lib/ghl.mjs';
export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      const [rows, pendingSync] = await Promise.all([
        sql`select * from job_shared_state order by updated_at desc`,
        sql`select job_id as "jobId", last_error as error from dispatch_crm_sync where pending = true`
      ]);
      return json({ sharedState: rows.map(jobRecord), pendingSync });
    }
    const payload = await readPayload(request);
    const result = await saveState(sql, 'job', payload);
    if (['save_times', 'reset_dispatch'].includes(payload.action)) {
      try { result.crmSync = await syncJobSchedule(sql, result.record.jobId); }
      catch { result.crmSync = { ok: false, error: 'Dispatch saved. GHL schedule sync needs a retry.' }; }
    }
    return json(result);
  } catch (error) { return errorResponse(error); }
}
