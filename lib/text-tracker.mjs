// Admin > Schedule text tracker (senior admins). One row per worker on every open job
// from yesterday through the next 7 days: is their schedule text waiting for its 12 hour
// mark, sent (Twilio took it), delivered (Twilio's delivery report), failed, overdue or
// never queued. Built only from what the server recorded, so it shows what really
// happened, not what the board expected.
import { ensureHoldTables, holdSchedule, jobStartUtc, holdHours, ledgerMatch, workerKey, sameWorker, rowWorkers, pacificParts, addDays } from './daily-dispatch.mjs';
import { toE164 } from './crew-text.mjs';
import { StateError } from './state.mjs';

export const OVERDUE_MS = 5 * 60e3;   // past its send time by this much: overdue
export const STALL_MS = 2 * 60e3;     // a text "sending" longer than this: failed
const asJson = v => typeof v === 'string' ? JSON.parse(v) : (v || {});
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
// Statuses that need someone to look at them.
export const PROBLEM = new Set(['overdue', 'failed', 'undelivered', 'missed', 'no_phone']);
export const STATUS_LABEL = {
  delivered: 'Delivered', sent: 'Sent', sent_before: 'Sent (before tracking)', sending: 'Sending',
  pending: 'Waiting', overdue: 'Overdue', failed: 'Failed', undelivered: 'Not delivered',
  missed: 'Never queued', no_phone: 'No phone', dont_text: "Don't text", not_queued: 'No text planned'
};

// Acknowledge: a senior admin saw a red row and handled it. Keyed by status, so if the
// same worker turns red again for a different reason the row shows again.
export async function ensureAckTable(sql) {
  await sql`create table if not exists crew_text_ack (
    job_id text not null, report_date text not null, worker_key text not null, status text not null,
    acked_by text not null default '', created_at timestamptz not null default now(),
    primary key (job_id, report_date, worker_key, status))`;
}
// items: [{ key, status }] from the tracker rows. undo removes them.
export async function ackTexts(sql, { jobId, items, by = '', undo = false }) {
  await ensureAckTable(sql);
  const [row] = await sql`select data from job_shared_state where job_id = ${jobId}`;
  const date = asJson(row?.data).reportDate;
  if (!isDate(date)) throw new StateError('This job has no date. Refresh the tracker.', 409);
  const list = (Array.isArray(items) ? items : []).map(i => ({ key: String(i?.key || '').slice(0, 160), status: String(i?.status || '').slice(0, 40) }))
    .filter(i => i.key && (undo || PROBLEM.has(i.status))).slice(0, 40);
  for (const i of list) {
    if (undo) await sql`delete from crew_text_ack where job_id = ${jobId} and report_date = ${date} and worker_key = ${i.key}`;
    else await sql`insert into crew_text_ack (job_id, report_date, worker_key, status, acked_by) values (${jobId}, ${date}, ${i.key}, ${i.status}, ${String(by).slice(0, 120)})
      on conflict (job_id, report_date, worker_key, status) do nothing`;
  }
  return list.length;
}

export async function textTracker(sql, { now = Date.now(), days = 7 } = {}) {
  await ensureHoldTables(sql);
  await ensureAckTable(sql);
  const today = pacificParts(now).date, from = addDays(today, -1), to = addDays(today, days);
  const stateRows = await sql`select job_id, data from job_shared_state where active = true`;
  const jobs = stateRows.map(r => ({ jobId: r.job_id, state: asJson(r.data) }))
    .filter(j => isDate(j.state.reportDate) && j.state.reportDate >= from && j.state.reportDate <= to && Array.isArray(j.state.crew) && j.state.crew.some(w => w && w.name));
  const empty = { now: new Date(now).toISOString(), holdHours: holdHours(), today, summary: { workers: 0, sent: 0, delivered: 0, pending: 0, problems: 0, acknowledged: 0, other: 0 }, jobs: [] };
  if (!jobs.length) return empty;
  const ids = jobs.map(j => j.jobId);
  const held = new Map((await holdSchedule(sql)).map(j => [j.jobId, j]));
  const ledger = await sql`select job_id, report_date, worker_key, worker_name, worker_phone, contact_id, effect_id, updated_at from crew_notify where job_id = any(${ids}) and notified = true`;
  const logs = await sql`select job_id, report_date, phone, effect_id, created_at from crew_text_log where job_id = any(${ids})`;
  const skips = await sql`select job_id, report_date, worker_key, worker_name, skipped_by, created_at from crew_text_skip where job_id = any(${ids})`;
  const acks = await sql`select job_id, report_date, worker_key, status, acked_by, created_at from crew_text_ack where job_id = any(${ids})`;
  const effectIds = [...new Set(logs.map(l => l.effect_id).filter(id => id && id !== 'seed'))];
  const steps = effectIds.length ? await sql`select effect_id, phone, step, ref, created_at from crew_text_sends where effect_id = any(${effectIds}) and step <> 'plan'` : [];
  const effects = new Map((effectIds.length ? await sql`select effect_id, status, last_error, updated_at from dispatch_effects where effect_id = any(${effectIds})` : []).map(e => [e.effect_id, e]));
  const sids = [];
  for (const s of steps) if (s.step.startsWith('sms:')) { try { const sid = JSON.parse(s.ref).sid; if (sid) sids.push(sid); } catch {} }
  const delivery = new Map((sids.length ? await sql`select sid, status, error_code, updated_at from crew_text_status where sid = any(${sids})` : []).map(d => [d.sid, d]));

  const summary = { ...empty.summary };
  const out = [];
  for (const { jobId, state } of jobs) {
    const date = state.reportDate;
    const start = jobStartUtc(date, state.reportTime);
    const h = held.get(jobId);
    const dueAt = h?.dueAt ?? (start != null ? start - holdHours() * 3600e3 : null);
    const seen = new Set();
    const workers = [];
    for (const w of state.crew.filter(c => c && c.name)) {
      const key = workerKey(w); if (seen.has(key)) continue; seen.add(key);
      const led = ledger.find(r => r.job_id === jobId && r.report_date === date && ledgerMatch(r, w));
      const phone = toE164(w.phone || w.workerPhone || led?.worker_phone || '');
      const log = phone ? logs.find(l => l.job_id === jobId && l.report_date === date && l.phone === phone) : null;
      const waiting = (h?.rows || []).filter(r => r.payload.action !== 'remove' && rowWorkers(r.payload).some(x => sameWorker(x, w)));
      const skip = skips.find(s => s.job_id === jobId && s.report_date === date && (s.worker_key === key || (s.worker_name && s.worker_name.toLowerCase() === String(w.name).trim().toLowerCase())));
      const row = { key, name: String(w.name), phone, status: '', at: '', detail: '', effectId: '', canTextNow: false, canRetry: false };
      if (log) {
        const mine = steps.filter(s => s.effect_id === log.effect_id && s.phone === phone);
        const sms = mine.filter(s => s.step.startsWith('sms:'));
        if (log.effect_id === 'seed') Object.assign(row, { status: 'sent_before', at: log.created_at, detail: 'Sent through Make before the server texted' });
        else if (sms.length) {
          let sid = ''; try { sid = JSON.parse(sms[0].ref).sid || ''; } catch {}
          const d = delivery.get(sid);
          const ghl = mine.some(s => s.step.startsWith('ghl:'));
          if (d && ['undelivered', 'failed'].includes(d.status)) Object.assign(row, { status: 'undelivered', at: d.updated_at, detail: `Carrier said ${d.status}${d.error_code ? ` (Twilio error ${d.error_code})` : ''}. Check the number, then text them yourself.` });
          else if (d && ['delivered', 'read'].includes(d.status)) Object.assign(row, { status: 'delivered', at: d.updated_at, detail: ghl ? 'Logged in GHL' : '' });
          else Object.assign(row, { status: 'sent', at: sms[0].created_at, detail: [d ? `Twilio: ${d.status}` : 'Twilio took it; waiting for the delivery report', ghl ? 'logged in GHL' : ''].filter(Boolean).join(' · ') });
          row.sid = sid;
        } else {
          const e = effects.get(log.effect_id);
          const stalled = !e || e.status === 'uncertain' || now - new Date(log.created_at).getTime() > STALL_MS;
          Object.assign(row, stalled
            ? { status: 'failed', at: log.created_at, detail: e?.last_error || 'The text was started but Twilio never took it.', effectId: log.effect_id, canRetry: !!e && e.status !== 'confirmed' }
            : { status: 'sending', at: log.created_at });
        }
      } else if (skip && !waiting.length && !led) {
        Object.assign(row, { status: 'dont_text', at: skip.created_at, detail: skip.skipped_by ? `Assigned with Don't text by ${skip.skipped_by}` : "Assigned with Don't text" });
      } else if (!phone && (waiting.length || led)) {
        Object.assign(row, { status: 'no_phone', detail: 'No phone on file, so no text can go out.' });
      } else if (waiting.length) {
        const late = dueAt != null && dueAt < now - OVERDUE_MS;
        Object.assign(row, late
          ? { status: 'overdue', at: new Date(dueAt).toISOString(), detail: 'Should have gone out by now. The timer missed it.', canTextNow: true }
          : { status: 'pending', at: dueAt != null ? new Date(dueAt).toISOString() : '', detail: dueAt == null ? 'Waits for a job date, or Send now' : '' });
      } else if (led) {
        // Sent the job (Make run) but no text was ever started.
        const late = now - new Date(led.updated_at).getTime() > OVERDUE_MS;
        Object.assign(row, late
          ? { status: 'overdue', at: led.updated_at, detail: 'Make got the assign run, but the text never went out.', canTextNow: true }
          : { status: 'sending', at: led.updated_at });
      } else {
        const inside = dueAt != null && dueAt <= now;
        Object.assign(row, inside
          ? { status: 'missed', detail: "On the crew inside the 12 hours, but no text was ever queued (or Don't text was used before the tracker existed).", canTextNow: true }
          : { status: 'not_queued', detail: "Nothing queued for this worker. If Don't text wasn't meant, use Text now.", canTextNow: true });
      }
      row.label = STATUS_LABEL[row.status];
      row.problem = PROBLEM.has(row.status);
      const ack = row.problem && acks.find(a => a.job_id === jobId && a.report_date === date && a.worker_key === key && a.status === row.status);
      if (ack) { row.problem = false; row.acked = { by: ack.acked_by, at: new Date(ack.created_at).toISOString() }; }
      if (row.at instanceof Date) row.at = row.at.toISOString();
      summary.workers++;
      if (row.problem) summary.problems++;
      else if (row.acked) summary.acknowledged++;
      else if (['sent', 'sent_before'].includes(row.status)) summary.sent++;
      else if (row.status === 'delivered') { summary.sent++; summary.delivered++; }
      else if (['pending', 'sending'].includes(row.status)) summary.pending++;
      else summary.other++;
      workers.push(row);
    }
    out.push({
      jobId, name: String(state.jobAddress || state.clientName || jobId), client: String(state.clientName || ''), date,
      start: start != null ? new Date(start).toISOString() : '', dueAt: dueAt != null ? new Date(dueAt).toISOString() : '',
      problems: workers.filter(w => w.problem).length, workers
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || '') || a.name.localeCompare(b.name));
  return { ...empty, summary, jobs: out };
}
