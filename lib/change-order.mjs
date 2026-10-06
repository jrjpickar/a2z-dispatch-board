// Link a job to its parent opportunity as a change order.
// Order matters: the checks run first, then the opportunity is moved into the
// Change Order pipeline in GHL, and only then is the link saved. If GHL refuses,
// nothing is saved and GHL's reason is shown. The move is safe to repeat, so a
// retry after a version conflict just saves the link.
import { StateError, checkVersion } from './state.mjs';
import { saveState } from './store.mjs';
import { moveToChangeOrderPipeline } from './ghl.mjs';
import { logActivity } from './activity.mjs';
export async function linkChangeOrder(sql, payload, session, { move = moveToChangeOrderPipeline } = {}) {
  const jobId = String(payload.jobId || '').trim();
  const parentJobId = String(payload.parentJobId || '').trim();
  if (!jobId) throw new StateError('jobId is required');
  if (!parentJobId) throw new StateError('Pick the parent job for this change order');
  if (parentJobId === jobId) throw new StateError('A job cannot be a change order of itself');
  const [[current], [parent], [child]] = await Promise.all([
    sql`select * from job_shared_state where job_id = ${jobId}`,
    sql`select data from job_shared_state where job_id = ${parentJobId}`,
    sql`select job_id from job_shared_state where data->>'parentJobId' = ${jobId} limit 1`
  ]);
  if (current && current.active === false) throw new StateError('This job is closed. Reopen it explicitly before editing.', 409);
  checkVersion(current, payload);
  if (parent?.data?.parentJobId) throw new StateError('That job is itself a change order. Link to its parent job instead.', 409);
  if (child) throw new StateError('Other change orders are linked to this job, so it cannot become a change order itself.', 409);
  let ghlMove;
  try { ghlMove = await move(jobId); }
  catch (error) { throw new StateError(`GHL did not move the job to the Change Order pipeline, nothing was linked. ${error.reason || error.message || ''}`.trim(), 502); }
  const result = await saveState(sql, 'job', { ...payload, action: 'link_change_order', jobId, parentJobId, linkedBy: session?.name || payload.linkedBy || '' });
  if (!result.replayed) await logActivity(sql, session, 'Linked change order', `${payload.changeOrderName || jobId} to ${payload.parentJobName || parentJobId}`, { jobId, parentJobId, parentJobName: payload.parentJobName || '', ghl: ghlMove?.status || '' });
  return { ...result, ghlMove };
}
export async function unlinkChangeOrder(sql, payload, session) {
  const result = await saveState(sql, 'job', { ...payload, action: 'unlink_change_order' });
  if (!result.replayed) await logActivity(sql, session, 'Unlinked change order', payload.changeOrderName || payload.jobId, { jobId: payload.jobId, parentJobId: payload.parentJobId || '' });
  return result;
}
