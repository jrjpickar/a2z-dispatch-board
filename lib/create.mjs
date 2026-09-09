import { createHash } from 'node:crypto';
import { StateError } from './state.mjs';
import { saveState } from './store.mjs';
export function createdId(value) {
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { parsed = { opportunityId: value.trim() }; } }
  const id = parsed?.opportunityId || parsed?.jobId || parsed?.id || parsed?.opportunity?.id || parsed?.data?.opportunityId || '';
  if (/MAP_CREATED|REPLACE/i.test(String(id)) || !/^[A-Za-z0-9_-]{10,80}$/.test(String(id))) throw new StateError('Make must return the created opportunity ID. Check Make history before creating again.', 502);
  return String(id);
}
export async function createDispatch(sql, kind, payload) {
  const requestId = String(payload.requestId || '');
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) throw new StateError('Creation requestId is required', 428);
  if (payload.action !== 'create') throw new StateError('Only creation is supported here');
  const fingerprint = createHash('sha256').update(JSON.stringify({ kind, payload })).digest('hex');
  let creation = await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`create:${requestId}`}, 0))`;
    const [row] = await tx`select * from dispatch_creations where request_id = ${requestId}`;
    if (row) {
      if (row.fingerprint !== fingerprint) throw new StateError('This creation attempt already exists with different details. Check Make before starting another.', 409);
      return row;
    }
    await tx`insert into dispatch_creations (request_id, kind, fingerprint, payload, status) values (${requestId}, ${kind}, ${fingerprint}, ${tx.json(payload)}, 'sending')`;
    return { status: 'new' };
  });
  if (creation.result) return creation.result;
  if (creation.status === 'sending' || creation.status === 'uncertain') throw new StateError('Creation already attempted but not confirmed. Check Make history before creating again.', 409);
  if (creation.status === 'new') {
    const url = kind === 'job'
      ? process.env.JOB_ACTION_WEBHOOK || 'https://hook.us2.make.com/s2ijm77vf023z47b1dncn4jm9yt11w1d'
      : process.env.BOOK_CONTAINER_WEBHOOK || 'https://hook.us2.make.com/30np7d1bieaapqcluxlkxdgbg8l5pw2w';
    try {
      const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', ...(process.env.MAKE_API_KEY ? { 'x-make-apikey': process.env.MAKE_API_KEY } : {}) },
        body: JSON.stringify({ ...payload, eventId: requestId }) });
      if (!response.ok) throw new Error('Make did not confirm creation');
      const id = createdId(await response.text());
      await sql`update dispatch_creations set opportunity_id = ${id}, status = 'seed_pending', updated_at = now() where request_id = ${requestId}`;
      creation = { opportunity_id: id };
    } catch {
      await sql`update dispatch_creations set status = 'uncertain', updated_at = now() where request_id = ${requestId}`;
      throw new StateError('Creation was not confirmed with an opportunity ID. Check Make history before starting another.', 502);
    }
  }
  const id = creation.opportunity_id;
  // A lost browser connection cannot prevent dispatch state from being seeded.
  // A retry after a failed DB seed uses the stored ID, never calls Make again.
  const state = await saveState(sql, kind === 'job' ? 'job' : 'move', {
    ...payload, jobId: id, moveId: id, opportunityId: id, sourceOpportunityId: id,
    crew: [], assignedWorkers: [], expectedVersion: 0, requestId: `${requestId}-state`, action: 'create', active: true
  });
  const result = { ...state, opportunityId: id };
  await sql`update dispatch_creations set status = 'confirmed', result = ${sql.json(result)}, updated_at = now() where request_id = ${requestId}`;
  return result;
}
