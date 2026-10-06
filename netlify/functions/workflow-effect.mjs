import { createHash } from 'node:crypto';
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { assertEodPayload } from '../../lib/eod-xlsx.mjs';
import { workflows, sendWorkflow } from '../../lib/effects.mjs';
import { logSend } from '../../lib/activity.mjs';
export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') return json({ issues: await sql`select effect_id as id, kind, status, last_error as error from dispatch_effects where status <> 'confirmed' order by created_at desc limit 50` });
    const { requestId, kind, payload, effectKey } = await readPayload(request);
    if (!workflows[kind] || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new StateError('Valid workflow kind and payload required');
    // Never post a blank run: every workflow needs its action and record id.
    if (!String(payload.action || '').trim() || !String(payload.moveId || payload.jobId || payload.opportunityId || '').trim()) throw new StateError('Workflow payload is missing its action or record id; nothing was sent.');
    if (kind === 'eod_sheet') { try { assertEodPayload(payload); } catch (e) { throw new StateError(e.message); } }
    if (kind === 'worker_sent_home' && (!String(payload.workerName || '').trim() || !(Number(payload.hoursWorked) > 0))) throw new StateError('Worker sent home needs the worker and the hours worked; nothing was sent.');
    // effectKey lets one saved change fan out to several webhook calls (e.g. one
    // worker-assignment notification per assignee), each deduped on its own.
    const key = String(effectKey || '').replace(/[^\w+.-]/g, '').slice(0, 80);
    const effectId = key ? `${requestId}:${kind}:${key}` : `${requestId}:${kind}`;
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
      // The payload is kept so a senior admin can retry a failed run.
      await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload)
        values (${effectId}, ${requestId}, ${kind}, ${fingerprint}, 'sending', ${tx.json(payload)})`;
      return 'new';
    });
    if (claimed === 'confirmed') return json({ ok: true, replayed: true });
    if (claimed !== 'new') return json({ error: 'Workflow was already attempted. Check Make history before rerunning to avoid duplicate notifications.', status: claimed }, 409);
    try {
      const sent = await sendWorkflow(kind, payload, effectId);
      await sql`update dispatch_effects set status = 'confirmed', updated_at = now() where effect_id = ${effectId}`;
      if (kind === 'eod_sheet') await logSend(sql, { kind, jobId: payload.jobId, jobName: payload.jobName || payload.jobAddress, fileName: sent.fileName, status: 'sent' });
      return json({ ok: true });
    } catch (error) {
      await sql`update dispatch_effects set status = 'uncertain', last_error = ${String(error.message || 'Check Make execution history.').slice(0, 300)}, updated_at = now() where effect_id = ${effectId}`;
      if (kind === 'eod_sheet') await logSend(sql, { kind, jobId: payload.jobId, jobName: payload.jobName || payload.jobAddress, status: 'failed', detail: error.message });
      return json({ error: 'Dispatch saved; workflow completion is unconfirmed. Check Make execution history.' }, 502);
    }
  } catch (error) { return errorResponse(error); }
}
