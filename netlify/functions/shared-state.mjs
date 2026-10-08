import { db, ensureSchema } from './db.mjs';
import { authorizeWrite, readPayload, json, errorResponse } from '../../lib/http.mjs';
import { jobRecord, saveState } from '../../lib/store.mjs';
import { syncJobSchedule } from '../../lib/ghl.mjs';
import { linkChangeOrder, unlinkChangeOrder } from '../../lib/change-order.mjs';
import { sessionFromRequest } from '../../lib/session.mjs';
import { logActivity } from '../../lib/activity.mjs';
// A since time a little in the past so a save that landed while the last poll ran is never missed.
function sinceParam(request) {
  const raw = new URL(request.url).searchParams.get('since');
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? new Date(t - 5000) : null;
}
export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      // ?since=<serverTime from the last answer>: only rows changed after it (polls stay tiny).
      const since = sinceParam(request);
      const [rows, pendingSync, [{ now }]] = await Promise.all([
        since ? sql`select * from job_shared_state where updated_at > ${since} order by updated_at desc`
              : sql`select * from job_shared_state order by updated_at desc`,
        sql`select job_id as "jobId", last_error as error from dispatch_crm_sync where pending = true`,
        sql`select now() as now`
      ]);
      return json({ sharedState: rows.map(jobRecord), pendingSync, serverTime: new Date(now).toISOString(), partial: !!since });
    }
    const payload = await readPayload(request);
    // Change order link/unlink: link also moves the opportunity to the Change Order pipeline in GHL.
    if (payload.action === 'link_change_order') return json(await linkChangeOrder(sql, payload, sessionFromRequest(request)));
    if (payload.action === 'unlink_change_order') return json(await unlinkChangeOrder(sql, payload, sessionFromRequest(request)));
    // Record who closed or reopened a job, so a closed job still showing on the board can be traced.
    const session = sessionFromRequest(request);
    if (['complete', 'cancel'].includes(payload.action) && session && !payload.closedBy) payload.closedBy = session.name;
    if (payload.action === 'reopen' && session && !payload.reopenedBy) payload.reopenedBy = session.name;
    if (payload.action === 'send_home' && session && !payload.sentHomeBy) payload.sentHomeBy = session.name;
    const result = await saveState(sql, 'job', payload);
    if (['complete', 'cancel', 'reopen'].includes(payload.action) && !result.replayed) {
      const label = { complete: 'Marked job completed', cancel: 'Marked job cancelled', reopen: 'Reopened job' }[payload.action];
      await logActivity(sql, session, label, payload.jobAddress || payload.jobId, { jobId: payload.jobId });
    }
    if (payload.action === 'send_home' && !result.replayed) await logActivity(sql, session, 'Sent worker home', `${payload.workerName || ''} (${payload.hoursWorked} h) from ${payload.jobAddress || payload.jobId}`, { jobId: payload.jobId, hoursWorked: payload.hoursWorked });
    if (['save_times', 'reset_dispatch'].includes(payload.action)) {
      try { result.crmSync = await syncJobSchedule(sql, result.record.jobId); }
      catch { result.crmSync = { ok: false, error: 'Dispatch saved. GHL schedule sync needs a retry.' }; }
    }
    return json(result);
  } catch (error) { return errorResponse(error); }
}
