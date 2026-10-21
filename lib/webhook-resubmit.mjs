import { createHash } from 'node:crypto';
import { StateError } from './state.mjs';
import { workflows } from './effects.mjs';
import { deliverEffect } from './effect-queue.mjs';
import { logActivity } from './activity.mjs';

// Called only after requireSenior. Snapshot the stored payload, never current board
// values (an EOD reset may already have cleared the crew and hours).
export async function resubmitWorkflow(sql, body, session, { deliver = deliverEffect } = {}) {
  const requestId = String(body.requestId || '');
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) throw new StateError('A resubmission requestId is required.', 428);
  const source = body.action === 'resubmit_schedule' ? `schedule:${String(body.jobId || '')}` : String(body.effectId || '');
  if (!source || source.length > 300) throw new StateError('Choose a saved webhook run.');
  const effectId = `resubmit:${requestId}`;
  const group = `resubmit:${source}`;
  const claimed = await sql.begin(async tx => {
    // Serialize clicks on the same source, including from different senior admins.
    await tx`select pg_advisory_xact_lock(hashtextextended(${group}, 0))`;
    const [existing] = await tx`select * from dispatch_effects where effect_id = ${effectId}`;
    if (existing) {
      if (existing.request_id !== group) throw new StateError('This resubmission request was already used for another run.', 409);
      return { row: existing, replayed: true };
    }
    let row;
    if (body.action === 'resubmit_schedule') {
      const [schedule] = await tx`select data from project_schedules where job_id = ${String(body.jobId || '')}`;
      if (!schedule?.data?.start || !schedule.data.phases?.some(p => p.on !== false)) throw new StateError('Save a Project Schedule with a start date and an enabled phase first.', 409);
      row = { kind: 'project_schedule', payload: schedule.data };
    } else {
      [row] = await tx`select * from dispatch_effects where effect_id = ${source}`;
      if (!row) throw new StateError('That webhook run was not found.', 404);
      if (['scheduled', 'cancelled'].includes(row.status)) throw new StateError('This run is waiting or was cancelled. Use its original send controls.', 409);
      if (row.status === 'sending' && Date.now() - new Date(row.updated_at).getTime() < 60000) throw new StateError('This webhook is still sending. Wait for its result.', 409);
    }
    if (!row.payload || !workflows[row.kind]) throw new StateError('The original payload is unavailable; this run cannot be resubmitted.', 409);
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const [inFlight] = await tx`select effect_id from dispatch_effects where request_id = ${group} and status = 'sending' and updated_at > now() - interval '60 seconds' limit 1`;
    if (inFlight) throw new StateError('A resubmission of this run is already sending.', 409);
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload)
      values (${effectId}, ${group}, ${row.kind}, ${fingerprint}, 'sending', ${tx.json(payload)})`;
    return { row: { effect_id: effectId, kind: row.kind, payload }, replayed: false };
  });
  if (claimed.replayed) return { ok: claimed.row.status === 'confirmed', replayed: true, effectId, status: claimed.row.status };
  const row = claimed.row;
  const name = row.payload.jobName || row.payload.jobAddress || row.payload.jobAddr || row.payload.jobId || '';
  await logActivity(sql, session, 'Resubmitted webhook', name, { source, effectId, kind: row.kind, result: 'sending' });
  const ok = await deliver(sql, row);
  await logActivity(sql, session, 'Webhook resubmission result', name, { source, effectId, kind: row.kind, result: ok ? 'sent' : 'failed' });
  return { ok, effectId, status: ok ? 'confirmed' : 'uncertain', ...(ok ? {} : { error: 'Resubmission was not confirmed. Check the webhook run and Make history.' }) };
}
