import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { waitsForNightly, sendJob, waitingSummary, nextDispatchUtc } from '../../lib/daily-dispatch.mjs';
import { recordEffect, deliverEffect, sendHeldEffects, cancelHeldEffects, QUIET_STATUSES } from '../../lib/effect-queue.mjs';
const idList = value => (Array.isArray(value) ? value : []).map(v => String(v || '').slice(0, 240)).filter(Boolean).slice(0, 20);
export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      // ?waiting=jobs: crew changes waiting for the 6:30 PM run, per job (Send now box).
      if (new URL(request.url).searchParams.get('waiting') === 'jobs') return json(await waitingSummary(sql));
      // Every open board polls this, so it also sends anything whose undo window is over.
      try { await sendHeldEffects(sql); } catch (error) { console.error('Held send sweep failed', error); }
      return json({ issues: await sql`select effect_id as id, kind, status, last_error as error from dispatch_effects where not (status = any(${QUIET_STATUSES})) order by created_at desc limit 50` });
    }
    const body = await readPayload(request);
    // Send now (job row): sends this job as it sits right now, without waiting for
    // 6:30 PM: its waiting Make assign / remove runs (net change only) and the
    // schedule text to anyone on it who hasn't gotten it for that day.
    if (body.op === 'job_send_now') {
      const jobId = String(body.jobId || '').slice(0, 160);
      if (!jobId) throw new StateError('Pick the job to send');
      const result = await sendJob(sql, jobId, { why: 'send_now' });
      const ok = !result.makeFailed && result.textOk;
      return json({ ok, ...result, ...(ok ? {} : { error: 'Some of it did not finish. Check Admin > Make / GHL problems.' }) });
    }
    // Undo window controls for held sends.
    if (body.op === 'cancel') {
      const ids = idList(body.effectIds); if (!ids.length) throw new StateError('Nothing to undo');
      const result = await cancelHeldEffects(sql, ids);
      return json({ ok: result.tooLate.length === 0, ...result });
    }
    if (body.op === 'send') {
      const ids = idList(body.effectIds); if (!ids.length) throw new StateError('Nothing to send');
      const result = await sendHeldEffects(sql, { ids });
      return json({ ok: result.failed.length === 0, ...result });
    }
    const { requestId, kind, payload, effectKey, delayMs } = body;
    // Crew schedule text from Assign selected: nothing to queue. The 6:30 PM run (or
    // Send now) texts everyone on the job who hasn't gotten it. Send schedule now
    // (rapidAssign) texts right away, below.
    if (kind === 'crew_text' && payload?.rapidAssign !== true) return json({ ok: true, waitsForNightly: true, nextRun: new Date(nextDispatchUtc()).toISOString() });
    // Assign / remove worker runs wait for the 6:30 PM run (or Send now on the job).
    if (waitsForNightly(kind, payload)) {
      const { effectId, status } = await recordEffect(sql, { requestId, kind, payload, effectKey, nightly: true });
      return json({ ok: status !== 'cancelled', waitsForNightly: true, effectId, status, nextRun: new Date(nextDispatchUtc()).toISOString() });
    }
    const { effectId, status } = await recordEffect(sql, { requestId, kind, payload, effectKey, delayMs });
    if (delayMs > 0) {
      if (status === 'new' || status === 'scheduled') return json({ ok: true, scheduled: true, effectId });
      return json({ ok: status !== 'cancelled', effectId, status });
    }
    if (status === 'confirmed') return json({ ok: true, replayed: true });
    if (status !== 'new') return json({ error: 'Workflow was already attempted. Check Make history before rerunning to avoid duplicate notifications.', status }, 409);
    const ok = await deliverEffect(sql, { effect_id: effectId, kind, payload });
    return ok ? json({ ok: true }) : json({ error: 'Dispatch saved; workflow completion is unconfirmed. Check Make execution history.' }, 502);
  } catch (error) { return errorResponse(error); }
}
