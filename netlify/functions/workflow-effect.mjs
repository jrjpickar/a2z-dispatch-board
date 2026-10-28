import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { crewTextDelayMs, heldCrewTexts, heldCrewTextIds } from '../../lib/crew-text.mjs';
import { recordEffect, deliverEffect, sendHeldEffects, cancelHeldEffects, QUIET_STATUSES } from '../../lib/effect-queue.mjs';
const idList = value => (Array.isArray(value) ? value : []).map(v => String(v || '').slice(0, 240)).filter(Boolean).slice(0, 20);
export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      // ?crewText=pending: crew schedule texts still waiting for their 12 hour mark (Send now button).
      if (new URL(request.url).searchParams.get('crewText') === 'pending') return json({ pending: await heldCrewTexts(sql) });
      // Every open board polls this, so it also sends anything whose undo window is over.
      try { await sendHeldEffects(sql); } catch (error) { console.error('Held send sweep failed', error); }
      return json({ issues: await sql`select effect_id as id, kind, status, last_error as error from dispatch_effects where not (status = any(${QUIET_STATUSES})) order by created_at desc limit 50` });
    }
    const body = await readPayload(request);
    // Send now (job row): sends this job's held crew schedule texts right away.
    // Only crew_text rows are touched; the Make runs already went out at assign time.
    if (body.op === 'crew_text_send_now') {
      const ids = await heldCrewTextIds(sql, String(body.jobId || ''));
      if (!ids.length) return json({ ok: true, sent: [], failed: [], nothingHeld: true });
      const result = await sendHeldEffects(sql, { ids, timeoutMs: 25000 });
      return json({ ok: result.failed.length === 0, ...result, ...(result.failed.length ? { error: 'Some crew texts did not finish. Check Admin > Make / GHL problems.' } : {}) });
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
    const { requestId, kind, payload, effectKey } = body;
    // Crew schedule text: the server sets when it goes out (12 hours before the start,
    // or now for Send schedule now), whatever the browser asked.
    const delayMs = kind === 'crew_text' ? crewTextDelayMs(payload) : body.delayMs;
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
