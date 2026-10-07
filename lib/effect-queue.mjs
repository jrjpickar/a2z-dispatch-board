// One place that turns a saved dispatch change into a Make run: validates the
// payload, records it in dispatch_effects (deduped on requestId + kind), and
// sends it now or holds it until due_at.
//
// Held sends are how the undo window on Completed/Cancelled works. The browser
// asks for a delay; the server owns the timer from then on, so a closed tab or a
// crashed browser cannot lose the send. Whatever is due goes out when:
//   * the board that queued it asks (end of the countdown, Send now, tab closing),
//   * any board polls /api/workflow-effect, or
//   * the effect-dispatcher scheduled function runs (every minute).
import { createHash } from 'node:crypto';
import { StateError } from './state.mjs';
import { assertEodPayload } from './eod-xlsx.mjs';
import { workflows, sendWorkflow } from './effects.mjs';
import { logSend } from './activity.mjs';

export const MAX_HOLD_MS = 120000;
// Statuses that are not problems: done, deliberately undone, or still waiting.
export const QUIET_STATUSES = ['confirmed', 'cancelled', 'scheduled'];

export function effectIdFor(requestId, kind, effectKey) {
  const key = String(effectKey || '').replace(/[^\w+.-]/g, '').slice(0, 80);
  return key ? `${requestId}:${kind}:${key}` : `${requestId}:${kind}`;
}

// Records the effect. Returns { effectId, status } where status is 'new' for a
// fresh row, or the earlier row's status for a repeat of the same request.
export async function recordEffect(sql, { requestId, kind, payload, effectKey, delayMs = 0 }) {
  if (!workflows[kind] || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new StateError('Valid workflow kind and payload required');
  // Never post a blank run: every workflow needs its action and record id.
  if (!String(payload.action || '').trim() || !String(payload.moveId || payload.jobId || payload.opportunityId || '').trim()) throw new StateError('Workflow payload is missing its action or record id; nothing was sent.');
  if (kind === 'eod_sheet') { try { assertEodPayload(payload); } catch (e) { throw new StateError(e.message); } }
  if (kind === 'worker_sent_home' && (!String(payload.workerName || '').trim() || !(Number(payload.hoursWorked) > 0))) throw new StateError('Worker sent home needs the worker and the hours worked; nothing was sent.');
  const hold = Math.round(Number(delayMs) || 0);
  if (hold < 0 || hold > MAX_HOLD_MS) throw new StateError(`A held send can wait at most ${MAX_HOLD_MS / 1000} seconds`);
  const effectId = effectIdFor(requestId, kind, effectKey);
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const status = await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${effectId}, 0))`;
    const [mutation] = await tx`select result from dispatch_requests where request_id = ${String(requestId || '')}`;
    if (!mutation) throw new StateError('A confirmed dispatch save must precede its workflow', 409);
    const resource = mutation.result.record?.jobId || mutation.result.state?.moveId;
    if (resource !== String(payload.moveId || payload.jobId || payload.opportunityId || '')) throw new StateError('Workflow does not match the saved record', 409);
    const [previous] = await tx`select * from dispatch_effects where effect_id = ${effectId}`;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new StateError('Workflow request was already used with a different payload', 409);
      return previous.status;
    }
    // The payload is kept so a held send can go out later and a senior admin can retry a failed run.
    if (hold > 0) {
      await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload, due_at)
        values (${effectId}, ${requestId}, ${kind}, ${fingerprint}, 'scheduled', ${tx.json(payload)}, now() + (${hold}::int * interval '1 millisecond'))`;
    } else {
      await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload)
        values (${effectId}, ${requestId}, ${kind}, ${fingerprint}, 'sending', ${tx.json(payload)})`;
    }
    return 'new';
  });
  return { effectId, status };
}

// Sends a row that is already marked 'sending'. Returns true when Make confirmed.
export async function deliverEffect(sql, row, { timeoutMs } = {}) {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  try {
    const sent = await sendWorkflow(row.kind, payload, row.effect_id, { timeoutMs });
    await sql`update dispatch_effects set status = 'confirmed', last_error = null, updated_at = now() where effect_id = ${row.effect_id}`;
    if (row.kind === 'eod_sheet') await logSend(sql, { kind: row.kind, jobId: payload.jobId, jobName: payload.jobName || payload.jobAddress, fileName: sent.fileName, status: 'sent' });
    return true;
  } catch (error) {
    await sql`update dispatch_effects set status = 'uncertain', last_error = ${String(error.message || 'Check Make execution history.').slice(0, 300)}, updated_at = now() where effect_id = ${row.effect_id}`;
    if (row.kind === 'eod_sheet') await logSend(sql, { kind: row.kind, jobId: payload.jobId, jobName: payload.jobName || payload.jobAddress, status: 'failed', detail: error.message });
    return false;
  }
}

// Claims held rows (scheduled -> sending) in one statement, so two callers can
// never both send the same one. `ids` limits it to those rows and ignores due_at
// (Send now); without ids it takes everything that is due.
export async function sendHeldEffects(sql, { ids, timeoutMs } = {}) {
  const claimed = ids
    ? await sql`update dispatch_effects set status = 'sending', updated_at = now()
        where effect_id = any(${ids}) and status = 'scheduled' returning effect_id, kind, payload`
    : await sql`update dispatch_effects set status = 'sending', updated_at = now()
        where status = 'scheduled' and due_at <= now() returning effect_id, kind, payload`;
  const results = await Promise.all(claimed.map(row => deliverEffect(sql, row, { timeoutMs })));
  return { claimed: claimed.map(r => r.effect_id), sent: claimed.filter((_, i) => results[i]).map(r => r.effect_id), failed: claimed.filter((_, i) => !results[i]).map(r => r.effect_id) };
}

// Undo: only rows still waiting can be cancelled. Anything already sending or
// sent is reported back so the board can say it was too late.
export async function cancelHeldEffects(sql, ids) {
  const cancelled = (await sql`update dispatch_effects set status = 'cancelled', last_error = 'Undone on the board before sending', updated_at = now()
    where effect_id = any(${ids}) and status = 'scheduled' returning effect_id`).map(r => r.effect_id);
  const rest = ids.filter(id => !cancelled.includes(id));
  const others = rest.length ? await sql`select effect_id, status from dispatch_effects where effect_id = any(${rest})` : [];
  return { cancelled, tooLate: others.filter(r => r.status !== 'cancelled').map(r => r.effect_id) };
}
