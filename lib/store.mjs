import { createHash } from 'node:crypto';
import { StateError, checkVersion, mutateJob, mutateMove } from './state.mjs';
export const jobRecord = row => ({ ...row.data, jobId: row.job_id, active: row.active, version: row.version, updatedAt: row.updated_at });
export const moveRecord = row => ({ ...row.data, moveId: row.move_id, version: row.version, updatedAt: row.updated_at });
export async function saveState(sql, kind, input, context = {}) {
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
    let scheduleReady = false;
    if (kind === 'job' && input.action === 'save_times' && (context.contract || current?.data?.jobType === 'contract') && !current?.data?.timesFirstLockedAt) {
      const [schedule] = await tx`select data from project_schedules where job_id = ${id}`;
      scheduleReady = Boolean(schedule?.data?.start && schedule.data.phases?.some(p => p.on !== false));
    }
    const next = kind === 'job' ? mutateJob(current, input, { ...context, scheduleReady }) : mutateMove(current, input);
    if (kind === 'job' && ['reset_dispatch', 'complete'].includes(input.action)) await logJobDay(tx, id, current?.data, input.action === 'complete' ? 'complete' : 'eod');
    if (kind === 'move' && (input.action === 'complete' || (input.action === 'reset_dispatch' && !input.unscheduled))) await logMoveRun(tx, id, current?.data, input.action === 'complete' ? 'complete' : 'reset_day');
    // A vehicle on another open move needs allowShared (the board asks dispatch first).
    if (kind === 'move' && input.action === 'assign_asset' && input.allowShared !== true) {
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

// KPI history (job_day_log): the day's schedule and crew as they were just before
// Complete EOD Sheet / Completed cleared them. One row per job per report date; a
// later write for the same day keeps the crew already logged if this one has none.
export function jobDayEntry(data) {
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.reportDate || ''))) return null;
  const crew = (Array.isArray(data.crew) ? data.crew : []).map(w => ({ id: String(w.id || ''), name: String(w.name || ''), phone: String(w.phone || '') })).filter(w => w.name);
  const sentHome = (Array.isArray(data.sentHome) ? data.sentHome : []).filter(s => !s.reportDate || s.reportDate === data.reportDate)
    .map(s => ({ id: String(s.id || ''), name: String(s.name || ''), hoursWorked: Number(s.hoursWorked) || 0 }));
  return {
    reportDate: data.reportDate, reportTime: data.reportTime || '', reportEndDate: data.reportEndDate || '', reportEndTime: data.reportEndTime || '',
    nightWork: !!data.nightWork, jobType: data.jobType || '', pipelineId: data.pipelineId || '', crewSize: data.crewSize ?? null,
    jobAddress: data.jobAddress || '', clientName: data.clientName || '', monetaryValue: data.monetaryValue ?? null, crew, sentHome
  };
}
async function logJobDay(tx, jobId, data, source) {
  const entry = jobDayEntry(data);
  if (!entry) return;
  const [existing] = await tx`select data from job_day_log where job_id = ${jobId} and report_date = ${entry.reportDate}`;
  if (existing) {
    const old = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
    if (!entry.crew.length && old?.crew?.length) entry.crew = old.crew;
    if (!entry.sentHome.length && old?.sentHome?.length) entry.sentHome = old.sentHome;
    await tx`update job_day_log set data = ${tx.json(entry)}, source = ${source}, logged_at = now() where job_id = ${jobId} and report_date = ${entry.reportDate}`;
  } else {
    await tx`insert into job_day_log (job_id, report_date, data, source) values (${jobId}, ${entry.reportDate}, ${tx.json(entry)}, ${source})`;
  }
}

// KPI history (move_run_log): one logistics run as it was before Reset day /
// Complete cleared its schedule, driver and vehicles. Needs a scheduled date.
export function moveRunEntry(data) {
  if (!data) return null;
  const date = String(data.scheduledDate || data.requestedDate || data.reportDate || data.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const assetIds = [...new Set([...(Array.isArray(data.assets) ? data.assets : []).map(a => String(a.assetId || a.id || '')), ...(data.assetId ? [String(data.assetId)] : [])])].filter(Boolean);
  return {
    runDate: date, time: String(data.scheduledTime || data.requestedTime || data.reportTime || ''),
    movementType: String(data.movementType || data.moveType || ''), containerSize: String(data.containerSize || ''),
    equipment: String(data.equipment || ''), loadCount: Number(data.loadCount) || 1,
    driverName: String(data.driverName || data.assignedDriverName || ''), assetIds,
    sourceOpportunityId: String(data.sourceOpportunityId || data.opportunityId || data.jobId || ''),
    sourceType: String(data.sourceType || ''), targetType: String(data.targetType || ''), addonType: String(data.addonType || ''),
    jobAddress: String(data.destinationAddress || data.deliveryAddress || data.jobAddress || ''), clientName: String(data.clientName || ''),
    monetaryValue: data.monetaryValue ?? null
  };
}
async function logMoveRun(tx, moveId, data, source) {
  const entry = moveRunEntry(data);
  if (!entry) return;
  await tx`insert into move_run_log (move_id, run_date, movement_type, data, source) values (${moveId}, ${entry.runDate}, ${entry.movementType}, ${tx.json(entry)}, ${source})
    on conflict (move_id, run_date, movement_type) do update set data = excluded.data, source = excluded.source, logged_at = now()`;
}
