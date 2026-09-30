// Senior admin tools (Admin page). Senior admins only, except that problems,
// activity and history can be shared read-only with all admins (lib/layout.mjs).
//   GET  /api/senior?view=activity   -> { activity: [...] }       who did what, newest first
//   GET  /api/senior?view=problems   -> { effects: [...], crm: [...] } Make runs and GHL syncs that didn't go through
//   GET  /api/senior?view=history    -> { sends: [...] }          EOD sheets + Project Schedule PDFs sent
//   GET  /api/senior?view=settings   -> senior settings
//   POST /api/senior { action: "retry_effect" | "resolve_effect", effectId }
//   POST /api/senior { action: "retry_crm" | "resolve_crm", jobId }
//   POST /api/senior { action: "save_settings", defaultAssignedUserId?, defaultMarkupPercent?, adminPin?, clearAdminPin? }
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { requireSenior } from '../../lib/session.mjs';
import { requirePanel } from '../../lib/layout.mjs';
import { logActivity, recentActivity, logSend, sendHistory } from '../../lib/activity.mjs';
import { seniorSettings, saveSettings } from '../../lib/settings.mjs';
import { sendWorkflow, workflows } from '../../lib/effects.mjs';
import { syncJobSchedule } from '../../lib/ghl.mjs';

const KIND_LABELS = { workers: 'Worker notification', drivers: 'Driver notification', job_details: 'Job details update', job_stage: 'Job stage (complete/cancel)', container: 'Container update', driver_log: 'Driver log', eod_sheet: 'EOD sheet' };
const recordName = p => p ? String(p.jobName || p.jobAddress || p.clientName || p.workerName || p.driverName || '') : '';

async function problems(sql) {
  // Nothing counts as a problem until Make has had 45 s to answer. A run still
  // marked "sending" after that never got an answer (Make or Netlify timed out).
  const effects = (await sql`select effect_id, kind, status, last_error, payload, created_at, updated_at from dispatch_effects
    where status <> 'confirmed' and updated_at < now() - interval '45 seconds'
    order by updated_at desc limit 100`).map(r => ({
      id: r.effect_id, kind: r.kind, label: KIND_LABELS[r.kind] || r.kind, status: r.status,
      error: r.status === 'sending' ? 'No answer from Make (timed out). Check Make history.' : (r.last_error || ''),
      jobId: String(r.payload?.jobId || r.payload?.moveId || r.payload?.opportunityId || ''), name: recordName(r.payload),
      action: String(r.payload?.action || ''), canRetry: !!r.payload && !!workflows[r.kind], at: r.updated_at || r.created_at
    }));
  const crm = (await sql`select c.job_id, c.last_error, c.updated_at, s.data from dispatch_crm_sync c
    left join job_shared_state s on s.job_id = c.job_id where c.pending = true and c.updated_at < now() - interval '45 seconds' order by c.updated_at desc limit 100`).map(r => ({
      jobId: r.job_id, error: r.last_error || '', at: r.updated_at, name: String(r.data?.jobAddress || r.data?.clientName || '')
    }));
  return { effects, crm };
}
async function history(sql) {
  const sends = await sendHistory(sql);
  // Project Schedules sent before the log existed still show, from their last-sent stamp.
  const older = await sql`select job_id, data, sent_at, sent_file from project_schedules where sent_at is not null`;
  for (const r of older) {
    if (sends.some(s => s.kind === 'project_schedule' && s.jobId === r.job_id)) continue;
    sends.push({ id: `ps-${r.job_id}`, at: r.sent_at, kind: 'project_schedule', jobId: r.job_id, jobName: String(r.data?.jobName || r.data?.jobAddr || ''), fileName: r.sent_file || '', status: 'sent', detail: 'last send before history started' });
  }
  return sends.sort((a, b) => new Date(b.at) - new Date(a.at));
}

export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      const view = new URL(request.url).searchParams.get('view');
      // Problems, activity and send history can be shared with every admin (read-only)
      // from the Admin page layout. Settings stay senior only.
      const panel = { problems: 'problems', activity: 'activity', history: 'history' }[view];
      if (panel) await requirePanel(request, sql, panel); else await requireSenior(request, sql);
      if (view === 'activity') return json({ activity: await recentActivity(sql) });
      if (view === 'problems') return json(await problems(sql));
      if (view === 'history') return json({ sends: await history(sql) });
      if (view === 'settings') return json(await seniorSettings(sql));
      throw new StateError('Unknown view');
    }
    authorizeWrite(request);
    const session = await requireSenior(request, sql);
    const body = await readPayload(request);
    if (body.action === 'retry_effect' || body.action === 'resolve_effect') {
      const effectId = String(body.effectId || '');
      const [row] = await sql`select * from dispatch_effects where effect_id = ${effectId}`;
      if (!row) throw new StateError('That workflow was not found.', 404);
      if (row.status === 'confirmed') return json({ ok: true, ...(await problems(sql)) });
      const label = KIND_LABELS[row.kind] || row.kind, name = recordName(row.payload);
      if (body.action === 'resolve_effect') {
        await sql`update dispatch_effects set status = 'confirmed', last_error = 'Acknowledged by ' || ${session.name}, updated_at = now() where effect_id = ${effectId}`;
        await logActivity(sql, session, `Acknowledged ${label}`, name, { effectId });
        return json({ ok: true, ...(await problems(sql)) });
      }
      if (!row.payload || !workflows[row.kind]) throw new StateError('This one was sent before retries were possible. Check Make, then Acknowledge it.', 409);
      // Same eventId as the first try, so a Make filter on eventId can drop duplicates.
      try {
        const sent = await sendWorkflow(row.kind, row.payload, effectId);
        await sql`update dispatch_effects set status = 'confirmed', last_error = null, updated_at = now() where effect_id = ${effectId}`;
        if (row.kind === 'eod_sheet') await logSend(sql, { kind: 'eod_sheet', jobId: row.payload.jobId, jobName: name, fileName: sent.fileName, status: 'sent', detail: 'retry' });
        await logActivity(sql, session, `Retried ${label}`, name, { effectId, result: 'sent' });
      } catch (error) {
        await sql`update dispatch_effects set status = 'uncertain', last_error = ${String(error.message).slice(0, 300)}, updated_at = now() where effect_id = ${effectId}`;
        await logActivity(sql, session, `Retried ${label}`, name, { effectId, result: 'failed', error: error.message });
        return json({ error: `Retry failed: ${error.message}`, ...(await problems(sql)) }, 502);
      }
      return json({ ok: true, ...(await problems(sql)) });
    }
    if (body.action === 'resolve_all') {
      const cleared = await sql`update dispatch_effects set status = 'confirmed', last_error = 'Acknowledged by ' || ${session.name}, updated_at = now()
        where status <> 'confirmed' and updated_at < now() - interval '45 seconds' returning effect_id`;
      await logActivity(sql, session, 'Acknowledged all Make problems', `${cleared.length} runs`);
      return json({ ok: true, ...(await problems(sql)) });
    }
    if (body.action === 'retry_crm') {
      const jobId = String(body.jobId || '');
      if (!jobId) throw new StateError('jobId required');
      const result = await syncJobSchedule(sql, jobId);
      await logActivity(sql, session, 'Retried GHL schedule sync', jobId, { result: result.ok ? 'sent' : 'failed' });
      return json({ ...(result.ok ? { ok: true } : { error: 'GHL still refused the schedule update.' }), ...(await problems(sql)) }, result.ok ? 200 : 502);
    }
    if (body.action === 'resolve_crm') {
      // Clears the stuck sync without calling GHL or Make. The board keeps its saved times.
      const jobId = String(body.jobId || '');
      if (!jobId) throw new StateError('jobId required');
      const cleared = await sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`job:${jobId}`}, 0))`;
        return tx`update dispatch_crm_sync set pending = false, last_error = 'Acknowledged by ' || ${session.name}, updated_at = now()
          where job_id = ${jobId} and pending = true returning job_id`;
      });
      if (cleared.length) await logActivity(sql, session, 'Acknowledged GHL schedule sync', jobId);
      return json({ ok: true, ...(await problems(sql)) });
    }
    if (body.action === 'save_settings') {
      const changed = await saveSettings(sql, body, session.name);
      if (changed.length) await logActivity(sql, session, 'Changed settings', changed.join(', '));
      return json({ ok: true, settings: await seniorSettings(sql) });
    }
    throw new StateError('Unknown action');
  } catch (error) { return errorResponse(error); }
}
