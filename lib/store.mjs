import { createHash } from 'node:crypto';
import { StateError, checkVersion, mutateJob, mutateMove } from './state.mjs';
export const jobRecord = row => ({ ...row.data, jobId: row.job_id, active: row.active, version: row.version, updatedAt: row.updated_at });
export const moveRecord = row => ({ ...row.data, moveId: row.move_id, version: row.version, updatedAt: row.updated_at });
export async function saveState(sql, kind, input) {
  const id = String(kind === 'job' ? input.jobId || input.opportunityId || '' : input.moveId || '').trim();
  if (!id || id.length > 160) throw new StateError(`${kind === 'job' ? 'jobId' : 'moveId'} is required (maximum 160 characters)`);
  const requestId = String(input.requestId || '');
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) throw new StateError('A unique requestId is required', 428);
  const fingerprint = createHash('sha256').update(JSON.stringify({ kind, id, input })).digest('hex');
  return sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`request:${requestId}`}, 0))`;
    const [previous] = await tx`select fingerprint, result from dispatch_requests where request_id = ${requestId}`;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new StateError('requestId was already used with a different payload', 409);
      return { ...previous.result, replayed: true };
    }
    // Serialize asset ownership changes as well as updates to a move.
    if (kind === 'move') await tx`select pg_advisory_xact_lock(824291002)`;
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${kind}:${id}`}, 0))`;
    const [current] = kind === 'job'
      ? await tx`select * from job_shared_state where job_id = ${id} for update`
      : await tx`select * from logistics_move_state where move_id = ${id} for update`;
    checkVersion(current, input);
    const next = kind === 'job' ? mutateJob(current, input) : mutateMove(current, input);
    if (kind === 'move' && input.action === 'assign_asset') {
      const rows = await tx`select move_id, data from logistics_move_state where move_id <> ${id}`;
      if (rows.some(r => r.data.active !== false && !/complete|cancel/.test(r.data.status || '') && (String(r.data.assetId || '') === String(input.assetId) || (Array.isArray(r.data.assets) ? r.data.assets : []).some(a => String(a.assetId || a.id) === String(input.assetId))))) throw new StateError('This asset is already assigned to another move.', 409);
    }
    const version = Number(current?.version || 0) + 1;
    let row;
    if (kind === 'job') {
      [row] = await tx`insert into job_shared_state (job_id, data, active, version, updated_at)
        values (${id}, ${tx.json(next.data)}, ${next.active}, ${version}, now())
        on conflict (job_id) do update set data = excluded.data, active = excluded.active, version = excluded.version, updated_at = now() returning *`;
      if (['save_times', 'reset_dispatch'].includes(input.action)) await tx`insert into dispatch_crm_sync (job_id) values (${id})
        on conflict (job_id) do update set pending = true, last_error = null, updated_at = now()`;
    } else {
      [row] = await tx`insert into logistics_move_state (move_id, data, version, updated_at)
        values (${id}, ${tx.json(next.data)}, ${version}, now())
        on conflict (move_id) do update set data = excluded.data, version = excluded.version, updated_at = now() returning *`;
    }
    const result = kind === 'job' ? { ok: true, record: jobRecord(row) } : { ok: true, state: moveRecord(row) };
    await tx`insert into dispatch_requests (request_id, fingerprint, result) values (${requestId}, ${fingerprint}, ${tx.json(result)})`;
    return result;
  });
}
