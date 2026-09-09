import { createHash } from 'node:crypto';
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
// Existing workflows retained. Only non-state effects belong in these scenarios.
const workflows = {
  workers: ['WORKER_EFFECT_WEBHOOK', 'https://hook.us2.make.com/dk8dm3t7opzdpmemah0gor2wiq3swq5l'],
  drivers: ['DRIVER_EFFECT_WEBHOOK', 'https://hook.us2.make.com/y7ko2j9343i7mvy1zzweq6db25f31t8k'],
  job_details: ['JOB_DETAILS_WEBHOOK', 'https://hook.us2.make.com/urj9p6bifsl1m9s72y8sq02zn2gydv59'],
  job_stage: ['JOB_ACTION_WEBHOOK', 'https://hook.us2.make.com/s2ijm77vf023z47b1dncn4jm9yt11w1d'],
  container: ['BOOK_CONTAINER_WEBHOOK', 'https://hook.us2.make.com/30np7d1bieaapqcluxlkxdgbg8l5pw2w'],
  driver_log: ['DRIVER_LOG_WEBHOOK', 'https://hook.us2.make.com/tp2wwcdltmjyi1gsrc9mhywksiygqouo']
};
export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') return json({ issues: await sql`select effect_id as id, kind, status, last_error as error from dispatch_effects where status <> 'confirmed' order by created_at desc limit 50` });
    const { requestId, kind, payload } = await readPayload(request);
    if (!workflows[kind] || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new StateError('Valid workflow kind and payload required');
    const effectId = `${requestId}:${kind}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const claimed = await sql.begin(async tx => {
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
      await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status)
        values (${effectId}, ${requestId}, ${kind}, ${fingerprint}, 'sending')`;
      return 'new';
    });
    if (claimed === 'confirmed') return json({ ok: true, replayed: true });
    if (claimed !== 'new') return json({ error: 'Workflow was already attempted. Check Make history before rerunning to avoid duplicate notifications.', status: claimed }, 409);
    const [env, fallback] = workflows[kind];
    try {
      const response = await fetch(process.env[env] || fallback, {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', ...(process.env.MAKE_API_KEY ? { 'x-make-apikey': process.env.MAKE_API_KEY } : {}) },
        body: JSON.stringify({ ...payload, eventId: effectId })
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(`Make did not confirm completion (HTTP ${response.status})`);
      await sql`update dispatch_effects set status = 'confirmed', updated_at = now() where effect_id = ${effectId}`;
      return json({ ok: true });
    } catch {
      await sql`update dispatch_effects set status = 'uncertain', last_error = 'Check Make execution history; do not automatically resend notifications.', updated_at = now() where effect_id = ${effectId}`;
      return json({ error: 'Dispatch saved; workflow completion is unconfirmed. Check Make execution history.' }, 502);
    }
  } catch (error) { return errorResponse(error); }
}
