// Field App "Request" button (lib/worker-request.mjs).
//   GET  /api/field-request   -> { ok, toolGroups: [{ group, tools: [...] }] }   the job log's special tools
//   POST /api/field-request { requestId, message, tools: [...], jobId?, lang }
//     -> { ok, queued }   one run on the worker_request webhook, sent in the background
// Uses the field app's sign-in token (Authorization: Bearer), like field-clock.
// jobId is optional; when sent it must be a job the worker is on. The same requestId
// twice (double tap, retry after a dropped connection) sends once. A run Make doesn't
// take shows under Admin > Make / GHL problems with Retry, like every other webhook.
import { db, ensureSchema } from './db.mjs';
import { json, readPayload, errorResponse } from '../../lib/http.mjs';
import { driverIdentityFromRequest, matchesWorker } from '../../lib/driver-token.mjs';
import { jobRecord } from '../../lib/store.mjs';
import { StateError } from '../../lib/state.mjs';
import { queueEffectNow, sendHeldEffects } from '../../lib/effect-queue.mjs';
import { cleanRequest, requestPayload, toolGroups } from '../../lib/worker-request.mjs';

export default async function handler(request, context) {
  try {
    const identity = driverIdentityFromRequest(request);
    if (!identity) throw new StateError('Sign in again', 401);
    if (request.method === 'GET') return json({ ok: true, toolGroups: toolGroups() }, 200, { 'cache-control': 'private, max-age=3600' });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await readPayload(request);
    const requestId = String(body.requestId || '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw new StateError('A unique requestId is required', 428);
    let clean;
    try { clean = cleanRequest(body); } catch (e) { throw new StateError(e.message, e.status || 400); }
    const sql = db(); await ensureSchema(sql);
    const [already] = await sql`select effect_id from dispatch_effects where kind = 'worker_request' and payload->>'requestId' = ${requestId} limit 1`;
    if (already) return json({ ok: true, queued: true, replayed: true });
    let job = {};
    const jobId = String(body.jobId || '').trim();
    if (jobId) {
      const [row] = await sql`select * from job_shared_state where job_id = ${jobId}`;
      const found = row ? jobRecord(row) : null;
      if (!found || found.active === false || !matchesWorker(found, identity)) throw new StateError("You're not on this job's crew. Pick another job or none.", 403);
      job = found;
    }
    const payload = requestPayload({ identity, job, request: clean, requestId });
    const effectId = await queueEffectNow(sql, { kind: 'worker_request', payload, effectKey: requestId });
    const send = sendHeldEffects(sql, { ids: [effectId], timeoutMs: 15000 }).catch(error => console.error('Worker request webhook not sent', requestId, error));
    if (context && typeof context.waitUntil === 'function') context.waitUntil(send);
    return json({ ok: true, queued: true });
  } catch (error) { return errorResponse(error); }
}
