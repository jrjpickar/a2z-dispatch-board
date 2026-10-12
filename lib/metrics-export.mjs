// Builds the KPI dashboard feed. Pure SQL reads; see netlify/functions/metrics-export.mjs.
const parse = v => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v);
const iso = v => (v ? new Date(v).toISOString() : '');
const num = v => { const n = Number(String(v ?? '').replace(/[$,\s%]/g, '')); return Number.isFinite(n) ? n : null; };
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// Older worked days: the job log payload sent on every Complete EOD Sheet since 1.8.
export function dayFromJobLog(payload) {
  const p = parse(payload) || {};
  if (!p.jobId || !isDate(p.reportDate)) return null;
  const crew = (Array.isArray(p.assignedWorkers) ? p.assignedWorkers : []).map(w => ({ id: String(w.contactId || w.id || ''), name: String(w.workerName || w.name || ''), phone: String(w.workerPhone || w.phone || '') })).filter(w => w.name);
  return { jobId: String(p.jobId), reportDate: p.reportDate, reportTime: p.reportTime || '', reportEndDate: p.reportEndDate || '', reportEndTime: p.reportEndTime || '',
    nightWork: p.nightWork === true || p.nightWork === 'true', jobAddress: p.jobAddress || '', clientName: p.clientName || '', monetaryValue: num(p.monetaryValue), crew, sentHome: [], source: 'job_log_backfill' };
}

export async function buildExport(sql) {
  const [jobs, moves, moveRuns, dayRows, jobLogs, eods, creations, rosters, manual, hidden, temps, health, pendingSync, [{ now }]] = await Promise.all([
    sql`select job_id, data, active, version, updated_at from job_shared_state`,
    sql`select move_id, data, version, updated_at from logistics_move_state`,
    sql`select move_id, run_date, data, source, logged_at from move_run_log`,
    sql`select job_id, report_date, data, source, logged_at from job_day_log`,
    sql`select payload, created_at from dispatch_effects where kind = 'job_log' and payload is not null`,
    sql`select payload, status, created_at from dispatch_effects where kind = 'eod_sheet' and payload is not null`,
    sql`select request_id, kind, payload, status, opportunity_id, updated_at from dispatch_creations where status = 'confirmed'`,
    sql`select kind, data, updated_at from dispatch_roster_cache`,
    sql`select contact_id, name, phone, is_labor, is_driver, created_at from dispatch_manual_workers`,
    sql`select worker_key, role, name, phone, contact_id, created_at from dispatch_hidden_workers`,
    sql`select contact_id, value, fetched_at from dispatch_worker_temperature`,
    sql`select kind, count(*) filter (where status = 'confirmed' and last_error is null)::int as ok,
          count(*) filter (where not (status = 'confirmed' and last_error is null))::int as bad
        from dispatch_effects where created_at >= now() - interval '30 days' group by kind`,
    sql`select count(*)::int as n from dispatch_crm_sync where pending = true`,
    sql`select now() as now`
  ]);
  const jobDays = new Map();
  for (const r of dayRows) jobDays.set(`${r.job_id}|${r.report_date}`, { jobId: r.job_id, ...parse(r.data), source: r.source, loggedAt: iso(r.logged_at) });
  // Backfill only days the log doesn't have yet (log rows win).
  for (const r of jobLogs) {
    const day = dayFromJobLog(r.payload);
    if (day && !jobDays.has(`${day.jobId}|${day.reportDate}`)) jobDays.set(`${day.jobId}|${day.reportDate}`, { ...day, loggedAt: iso(r.created_at) });
  }
  return {
    version: 1,
    serverTime: iso(now),
    timeZone: process.env.BOARD_TIME_ZONE || 'America/Los_Angeles',
    jobs: jobs.map(r => ({ ...parse(r.data), jobId: r.job_id, active: r.active, version: r.version, updatedAt: iso(r.updated_at) })),
    moves: moves.map(r => ({ ...parse(r.data), moveId: r.move_id, version: r.version, updatedAt: iso(r.updated_at) })),
    moveRuns: moveRuns.map(r => ({ moveId: r.move_id, ...parse(r.data), runDate: r.run_date, source: r.source, loggedAt: iso(r.logged_at) })),
    jobDays: [...jobDays.values()],
    bookings: creations.map(r => {
      const p = parse(r.payload) || {};
      return { opportunityId: r.opportunity_id, kind: r.kind, jobType: p.jobType || '', bookedBy: p.bookedBy || '', bookedByUserId: p.bookedByUserId || '', assignedUserId: p.assignedUserId || '', monetaryValue: num(p.monetaryValue), at: iso(r.updated_at) };
    }),
    eodSheets: eods.map(r => {
      const p = parse(r.payload) || {};
      return { jobId: String(p.jobId || p.opportunityId || ''), date: p.date || p.reportDate || '', totalJobCost: num(p.totalJobCost), totalPriceToCustomer: num(p.totalPriceToCustomer), markupPercent: num(p.markupPercent), status: r.status, at: iso(r.created_at) };
    }).filter(e => e.jobId),
    rosters: Object.fromEntries(rosters.map(r => [r.kind, { data: parse(r.data), updatedAt: iso(r.updated_at) }])),
    manualWorkers: manual.map(r => ({ contactId: r.contact_id, name: r.name, phone: r.phone, isLabor: r.is_labor, isDriver: r.is_driver, addedAt: iso(r.created_at) })),
    hiddenWorkers: hidden.map(r => ({ key: r.worker_key, role: r.role, name: r.name, phone: r.phone, contactId: r.contact_id, hiddenAt: iso(r.created_at) })),
    temperatures: temps.map(r => ({ contactId: r.contact_id, value: r.value, fetchedAt: iso(r.fetched_at) })),
    health: { makeRuns30d: health, pendingGhlScheduleSyncs: pendingSync[0]?.n || 0 }
  };
}
