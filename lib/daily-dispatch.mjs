// Crew notifications, held on the server until 12 hours before the job starts.
// (File name kept from the old 6:30 PM run so the repo paths stay the same.)
//
// Assign selected, the x on a crew chip and Unschedule save the crew right away. What
// goes to the worker webhook (dk8dm..., actions assign / remove), the split day webhook
// and the crew schedule text (Twilio) is decided here:
//
//   * Assign (normal): waits until 12 hours before the job's start (CREW_HOLD_HOURS).
//     At that moment the job goes out as it sits: each worker still on the job gets
//     their assign run (with the job's current times) and the schedule text. Assigned
//     inside the 12 hours: it goes right away.
//   * Send schedule now (rapid_assign, split day sendNow): right away, as before.
//   * Remove: only workers who were already notified for the job (sent inside the 12
//     hours or by Send schedule now) get a remove run, and they get it right away.
//     Anyone removed before they were notified gets nothing; their waiting assign is
//     simply dropped.
//   * Cancelled job: when the cancel goes out (after the 30 s undo), the job is wiped:
//     waiting runs are dropped, the job stage webhook (s2ijm...) is the only send for a
//     crew that was never notified, and workers who were notified get their remove run.
//   * Completed job / EOD sheet: waiting runs are dropped quietly, nobody is texted.
//
// No duplicates: crew_notify keeps, per job, day and worker, whether that worker has
// been sent the job. Every decision is made under a per job lock and updates that
// record before anything is sent, so two boards, a double click, the timer and Send
// now can never send the same worker the same thing twice. The schedule text is also
// claimed per job, day and phone before Twilio is called (lib/crew-text.mjs).
import { pacificToUtc, textedPhones, toE164, ensureTable as ensureTextTables } from './crew-text.mjs';
import { deliverEffect } from './effect-queue.mjs';

export const BATCH_GAP_MS = 15000; // more than one job due at the same moment: one job every 15 s
export const holdHours = () => { const n = Number(process.env.CREW_HOLD_HOURS ?? 12); return Number.isFinite(n) && n >= 0 && n <= 48 ? n : 12; };
const HELD_KINDS = ['workers', 'split_day'];
const HELD_ACTIONS = ['assign', 'remove', 'split_day_assign'];

// ---------- Pacific dates ----------
export function pacificParts(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isTime = v => /^\d{2}:\d{2}$/.test(String(v || ''));
// Start of a job in UTC ms. No start time: treated as 6:30 AM, so it goes out at 6:30 PM the day before.
export function jobStartUtc(date, time) {
  if (!isDate(date)) return null;
  return pacificToUtc(date, isTime(time) ? time : '06:30');
}
// When a job's held runs go out (null: no date yet, it waits for a date or Send now).
export function dueAtFor(state, rows = []) {
  const starts = [jobStartUtc(state?.reportDate, state?.reportTime)];
  // A split day run covers two jobs: it goes out 12 hours before the earlier one.
  for (const r of rows) if (r.payload?.action === 'split_day_assign') starts.push(jobStartUtc(r.payload.reportDate2, r.payload.reportTime2));
  const valid = starts.filter(v => v != null);
  return valid.length ? Math.min(...valid) - holdHours() * 3600e3 : null;
}

// ---------- Which runs ----------
export function isRapid(kind, payload) {
  if (!HELD_KINDS.includes(kind) || !payload) return false;
  return payload.action === 'rapid_assign' || payload.rapidAssign === true || (payload.action === 'split_day_assign' && payload.sendNow === true);
}
// Assign, remove and split day runs are held here (unless Send schedule now).
export function waitsForHold(kind, payload) {
  if (!HELD_KINDS.includes(kind) || !payload || isRapid(kind, payload)) return false;
  return HELD_ACTIONS.includes(String(payload.action || ''));
}
export const waitsForNightly = waitsForHold; // old name

// ---------- Workers ----------
const digits = v => String(v || '').replace(/\D/g, '').slice(-10);
export function workerKey(w) {
  const phone = digits(w?.workerPhone || w?.phone);
  if (phone) return 'p:' + phone;
  if (w?.contactId || w?.id) return 'c:' + (w.contactId || w.id);
  return 'n:' + String(w?.workerName || w?.name || '').trim().toLowerCase();
}
export function sameWorker(a, b) {
  const pa = digits(a.workerPhone || a.phone), pb = digits(b.workerPhone || b.phone);
  if (pa && pb) return pa === pb;
  const ca = a.contactId || a.id, cb = b.contactId || b.id;
  if (ca && cb) return ca === cb;
  return String(a.workerName || a.name || '').trim().toLowerCase() === String(b.workerName || b.name || '').trim().toLowerCase();
}
// The workers a run is about.
export function rowWorkers(payload) {
  if (payload.action === 'remove') return (Array.isArray(payload.removedWorkers) ? payload.removedWorkers : []).filter(w => w && (w.workerName || w.workerPhone));
  return [{ contactId: payload.contactId || '', workerName: payload.workerName || '', workerPhone: payload.workerPhone || '' }];
}
const workerFields = w => ({ contactId: String(w.contactId || w.id || ''), workerName: String(w.workerName || w.name || ''), workerPhone: String(w.workerPhone || w.phone || '') });

// An assign run goes out with the job's times as they are now.
export function refreshAssign(payload, state) {
  if (!state || payload.action !== 'assign') return payload;
  const night = state.nightWork === true || state.nightWork === 'true';
  const next = { ...payload };
  for (const k of ['reportDate', 'reportTime', 'reportEndDate', 'reportEndTime']) if (Object.hasOwn(state, k)) next[k] = state[k] || '';
  if (Object.hasOwn(state, 'nightWork')) { next.nightWork = night; next.shiftType = night ? 'night' : 'day'; }
  if (!payload.customTime) Object.assign(next, { workerReportDate: next.reportDate, workerReportTime: next.reportTime, workerReportEndDate: next.reportEndDate || next.reportDate, workerReportEndTime: next.reportEndTime });
  return next;
}

// ---------- The decision (pure, tested on its own) ----------
// rows: held runs for one job, oldest first ({ effect_id, kind, payload }).
// crew: the job's crew now. date: the job's day. ledger: crew_notify rows that are on.
// mode 'due' (12 hours reached, or Send now): everything is settled.
// mode 'removes' (before the 12 hours): only removes of notified workers go out.
// Returns { send: [{ row, payload, action, workers }], drop: [effect_id], keep: [effect_id] }.
export function decide(rows, { crew = [], date = '', ledger = [], today, mode = 'due' }) {
  const byWorker = new Map();
  for (const row of rows) for (const w of rowWorkers(row.payload)) {
    const key = workerKey(w);
    if (!byWorker.has(key)) byWorker.set(key, { worker: w, events: [] });
    byWorker.get(key).events.push({ row, type: row.payload.action === 'remove' ? 'remove' : 'assign', worker: w });
  }
  const chosen = new Map(); // effect_id -> { row, action, workers }
  for (const [key, { worker, events }] of byWorker) {
    const onCrew = crew.some(c => sameWorker(c, worker));
    const notifiedDay = !!date && ledger.some(r => r.worker_key === key && r.report_date === date);
    const notifiedAny = ledger.some(r => r.worker_key === key && r.report_date >= today);
    let action = null;
    if (!onCrew && notifiedAny) action = 'remove';
    else if (mode === 'due' && onCrew && !notifiedDay && date) action = 'assign';
    if (!action) continue;
    const last = [...events].reverse().find(e => e.type === action);
    if (!last) continue; // e.g. removed with Don't text: no remove run was asked for
    if (!chosen.has(last.row.effect_id)) chosen.set(last.row.effect_id, { row: last.row, action, workers: [] });
    chosen.get(last.row.effect_id).workers.push({ ...last.worker, key });
  }
  const send = [...chosen.values()].map(({ row, action, workers }) => {
    if (action !== 'remove') return { row, action, workers, payload: row.payload };
    // A remove run for several workers (Unschedule) only carries the ones being told.
    const all = rowWorkers(row.payload);
    return { row, action, workers, payload: workers.length === all.length ? row.payload : { ...row.payload, removedWorkers: workers.map(({ key, ...w }) => w) } };
  });
  const sentIds = new Set(send.map(s => s.row.effect_id));
  const rest = rows.filter(r => !sentIds.has(r.effect_id));
  // Before the 12 hours, waiting assigns stay waiting; removes that told nobody are done.
  const keep = mode === 'due' ? [] : rest.filter(r => r.payload.action !== 'remove').map(r => r.effect_id);
  const drop = rest.map(r => r.effect_id).filter(id => !keep.includes(id));
  return { send, drop, keep };
}
// Old helper (tests, sandbox): net change with no ledger, everything due.
export function netChanges(rows, crew) {
  const wasOn = new Set();
  const firstSeen = new Set();
  for (const row of rows) for (const w of rowWorkers(row.payload)) { const k = workerKey(w); if (firstSeen.has(k)) continue; firstSeen.add(k); if (row.payload.action === 'remove') wasOn.add(k); }
  const ledger = [...wasOn].map(k => ({ worker_key: k, report_date: '9999-12-31' }));
  const { send, drop } = decide(rows, { crew, date: '9999-12-31', ledger, today: '0000-00-00', mode: 'due' });
  return { send: send.filter(s => !(s.action === 'assign' && wasOn.has(s.workers[0].key))), drop };
}

// ---------- Tables ----------
let tablesReady;
export function ensureHoldTables(sql) {
  if (!tablesReady) tablesReady = createHoldTables(sql).catch(e => { tablesReady = undefined; throw e; });
  return tablesReady;
}
async function createHoldTables(sql) {
  await ensureTextTables(sql);
  // Who has been sent each job, per day. notified = false once a remove went out or the day was closed.
  await sql`create table if not exists crew_notify (
    job_id text not null, report_date text not null, worker_key text not null,
    worker_name text not null default '', worker_phone text not null default '', contact_id text not null default '',
    notified boolean not null default true, effect_id text not null default '', updated_at timestamptz not null default now(),
    primary key (job_id, report_date, worker_key))`;
  await sql`create index if not exists dispatch_effects_waiting_idx on dispatch_effects ((payload->>'jobId')) where status = 'nightly'`;
  const [done] = await sql`select 1 as ok from dispatch_settings where key = 'migration:crew-notify-seed'`;
  if (!done) await seedLedger(sql);
}
// One time, on the first request after deploy: workers Make was already sent for a job
// (the old assign went to Make on the click) count as notified, and are marked as texted
// so the server never texts them a second time.
async function seedLedger(sql) {
  const today = pacificParts().date;
  const states = await sql`select job_id, data from job_shared_state where active = true`;
  const sent = await sql`select effect_id, kind, payload from dispatch_effects where kind = any(${HELD_KINDS}) and status in ('confirmed', 'uncertain', 'sending') and payload is not null order by updated_at, effect_id`;
  const runs = sent.map(r => ({ ...r, payload: asJson(r.payload) }));
  for (const s of states) {
    const state = asJson(s.data); const date = String(state.reportDate || '');
    if (!isDate(date) || date < today) continue;
    for (const w of crewOfState(state)) {
      let last = null;
      for (const r of runs) {
        const p = r.payload;
        const forJob = String(p.jobId) === s.job_id || (p.action === 'split_day_assign' && String(p.jobId2 || '') === s.job_id);
        if (forJob && rowWorkers(p).some(x => sameWorker(x, w))) last = p.action;
      }
      if (!last || last === 'remove') continue;
      const f = workerFields(w);
      await sql`insert into crew_notify (job_id, report_date, worker_key, worker_name, worker_phone, contact_id, notified, effect_id)
        values (${s.job_id}, ${date}, ${workerKey(w)}, ${f.workerName}, ${f.workerPhone}, ${f.contactId}, true, 'seed') on conflict do nothing`;
      const phone = toE164(f.workerPhone);
      if (phone) await sql`insert into crew_text_log (job_id, report_date, phone, effect_id) values (${s.job_id}, ${date}, ${phone}, 'seed') on conflict do nothing`;
    }
  }
  await sql`insert into dispatch_settings (key, value, updated_by) values ('migration:crew-notify-seed', 'true'::jsonb, 'deploy') on conflict (key) do nothing`;
}

// ---------- Reading ----------
const asJson = v => typeof v === 'string' ? JSON.parse(v) : (v || {});
const crewOfState = s => (Array.isArray(s?.crew) ? s.crew : []).filter(w => w && w.name);
async function jobState(sql, jobId) {
  const [row] = await sql`select data, active from job_shared_state where job_id = ${String(jobId)}`;
  return row ? { ...asJson(row.data), active: row.active } : null;
}
async function heldRows(sql, jobId) {
  return (await sql`select effect_id, kind, payload, created_at from dispatch_effects where status = 'nightly' and payload->>'jobId' = ${String(jobId)} order by created_at, effect_id`)
    .map(r => ({ ...r, payload: asJson(r.payload) }));
}
async function ledgerOn(sql, jobId) {
  return sql`select report_date, worker_key, worker_name, worker_phone, contact_id from crew_notify where job_id = ${String(jobId)} and notified = true`;
}
const newId = (tag, jobId) => `${tag}:${jobId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const lockJob = (tx, jobId) => tx`select pg_advisory_xact_lock(hashtextextended(${'crew-hold:' + String(jobId)}, 0))`;

async function markNotified(tx, jobId, date, w, effectId) {
  const f = workerFields(w);
  await tx`insert into crew_notify (job_id, report_date, worker_key, worker_name, worker_phone, contact_id, notified, effect_id, updated_at)
    values (${String(jobId)}, ${String(date)}, ${workerKey(w)}, ${f.workerName}, ${f.workerPhone}, ${f.contactId}, true, ${effectId}, now())
    on conflict (job_id, report_date, worker_key) do update set notified = true, effect_id = excluded.effect_id, updated_at = now()`;
}
async function markRemoved(tx, jobId, w, today, effectId) {
  await tx`update crew_notify set notified = false, effect_id = ${effectId}, updated_at = now() where job_id = ${String(jobId)} and worker_key = ${workerKey(w)} and report_date >= ${today}`;
  // Told they're off: if they're put back later, they get the schedule text again.
  const phone = toE164(w.workerPhone || w.phone || '');
  if (phone) await tx`delete from crew_text_log where job_id = ${String(jobId)} and phone = ${phone} and report_date >= ${today}`;
}

// ---------- Sending one job ----------
// mode 'due': 12 hours reached (or Send now). mode 'removes': right after a remove, before the 12 hours.
export async function syncJob(sql, jobId, { mode = 'due', now = Date.now(), why = 'hold' } = {}) {
  jobId = String(jobId);
  const today = pacificParts(now).date;
  const plan = await sql.begin(async tx => {
    await lockJob(tx, jobId);
    const state = await jobState(tx, jobId);
    // Closed (or closing in its undo window): the cancel / complete settles it.
    if (!state || state.active === false) return null;
    const rows = await heldRows(tx, jobId);
    const ledger = await ledgerOn(tx, jobId);
    const date = isDate(state.reportDate) ? state.reportDate : '';
    const { send, drop } = decide(rows, { crew: crewOfState(state), date, ledger, today, mode });
    if (drop.length) await tx`update dispatch_effects set status = 'cancelled', last_error = ${mode === 'due' ? 'Nothing to send: canceled out or replaced before it went out' : 'Worker was not notified yet, so no remove run is needed'}, updated_at = now() where effect_id = any(${drop}) and status = 'nightly'`;
    const out = [];
    for (const s of send) {
      const payload = refreshAssign(s.payload, state);
      // Record who was told before anything is sent: a second caller sees it and sends nothing.
      if (s.action === 'remove') for (const w of s.workers) await markRemoved(tx, jobId, w, today, s.row.effect_id);
      else {
        for (const w of s.workers) await markNotified(tx, jobId, date, w, s.row.effect_id);
        if (s.row.payload.action === 'split_day_assign' && s.row.payload.jobId2 && isDate(s.row.payload.reportDate2)) for (const w of s.workers) await markNotified(tx, s.row.payload.jobId2, s.row.payload.reportDate2, w, s.row.effect_id);
      }
      const claimed = await tx`update dispatch_effects set status = 'sending', payload = ${tx.json(payload)}, updated_at = now() where effect_id = ${s.row.effect_id} and status = 'nightly' returning effect_id`;
      if (claimed.length) out.push({ effect_id: s.row.effect_id, kind: s.row.kind, payload });
    }
    return { state, out };
  });
  if (!plan) return { jobId, skipped: 'closed', makeSent: 0, makeFailed: 0, texted: 0, textOk: true };
  const results = await Promise.all(plan.out.map(row => deliverEffect(sql, row)));
  let texted = 0, textOk = true;
  if (mode === 'due') {
    const t = await textJob(sql, jobId, why);
    texted += t.texted; textOk = textOk && t.ok;
    // A split day worker also gets the other job's text.
    for (const row of plan.out) if (row.payload.action === 'split_day_assign' && row.payload.jobId2) { const t2 = await textJob(sql, row.payload.jobId2, why); texted += t2.texted; textOk = textOk && t2.ok; }
  }
  return { jobId, makeSent: results.filter(Boolean).length, makeFailed: results.filter(r => !r).length, texted, textOk };
}

// Schedule text (that job only) to every worker on it who was notified for that day and
// hasn't gotten it. Workers assigned with Don't text are never notified, so never texted.
export async function textJob(sql, jobId, why = 'hold') {
  jobId = String(jobId);
  const state = await jobState(sql, jobId);
  const date = state && state.active !== false && isDate(state.reportDate) ? state.reportDate : '';
  if (!date) return { texted: 0, ok: true };
  const ledger = (await ledgerOn(sql, jobId)).filter(r => r.report_date === date);
  const already = await textedPhones(sql, jobId, date);
  const textWorkers = crewOfState(state)
    .filter(w => ledger.some(r => r.worker_key === workerKey(w)))
    .map(workerFields).filter(w => { const p = toE164(w.workerPhone); return p && !already.has(p); });
  if (!textWorkers.length) return { texted: 0, ok: true };
  const effectId = newId(`${why}:crew_text`, jobId);
  const payload = { action: 'crewText', jobId, jobAddress: state.jobAddress || '', reportDate: date, timeZone: 'America/Los_Angeles', triggeredBy: why, textWorkers };
  await sql`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values (${effectId}, ${effectId}, 'crew_text', ${effectId}, 'sending', ${sql.json(payload)})`;
  const ok = await deliverEffect(sql, { effect_id: effectId, kind: 'crew_text', payload });
  return { texted: textWorkers.length, ok };
}

// Send schedule now (rapid): goes right away, once. A worker already sent this job for
// that day is not sent it again. Their waiting runs on the job are replaced by this one.
// The row is already recorded with status 'sending'. Returns 'send' or 'duplicate'.
export async function claimRapid(sql, { effectId, kind, payload, now = Date.now() }) {
  const jobId = String(payload.jobId);
  return sql.begin(async tx => {
    await lockJob(tx, jobId);
    const state = await jobState(tx, jobId);
    const date = isDate(state?.reportDate) ? state.reportDate : isDate(payload.reportDate) ? payload.reportDate : '';
    const ledger = await ledgerOn(tx, jobId);
    const w = rowWorkers(payload)[0];
    const key = workerKey(w);
    if (date && ledger.some(r => r.worker_key === key && r.report_date === date)) {
      await tx`update dispatch_effects set status = 'cancelled', last_error = 'Already sent to this worker for this job and day: not sent twice', updated_at = now() where effect_id = ${effectId}`;
      return 'duplicate';
    }
    if (date) await markNotified(tx, jobId, date, w, effectId);
    if (payload.action === 'split_day_assign' && payload.jobId2 && isDate(payload.reportDate2)) await markNotified(tx, payload.jobId2, payload.reportDate2, w, effectId);
    const mine = (await heldRows(tx, jobId)).filter(r => rowWorkers(r.payload).some(x => sameWorker(x, w)));
    for (const r of mine) {
      const others = rowWorkers(r.payload).filter(x => !sameWorker(x, w));
      if (r.payload.action === 'remove' && others.length) await tx`update dispatch_effects set payload = ${tx.json({ ...r.payload, removedWorkers: others })}, updated_at = now() where effect_id = ${r.effect_id}`;
      else await tx`update dispatch_effects set status = 'cancelled', last_error = 'Replaced by Send schedule now', updated_at = now() where effect_id = ${r.effect_id} and status = 'nightly'`;
    }
    return 'send';
  });
}

// Completed / cancelled job (when its stage change goes out, after the undo window).
// Waiting runs are dropped. Cancelled: workers who were notified get their remove run,
// and the job's notification records are wiped. Nobody else hears anything.
export async function closeJob(sql, jobId, action, { now = Date.now() } = {}) {
  jobId = String(jobId);
  const today = pacificParts(now).date;
  await ensureHoldTables(sql);
  const told = await sql.begin(async tx => {
    await lockJob(tx, jobId);
    const reason = action === 'cancel' ? 'Job cancelled before this went out' : 'Job completed before this went out';
    await tx`update dispatch_effects set status = 'cancelled', last_error = ${reason}, updated_at = now() where status = 'nightly' and payload->>'jobId' = ${jobId}`;
    const notified = action === 'cancel' ? (await ledgerOn(tx, jobId)).filter(r => r.report_date >= today) : [];
    await tx`delete from crew_notify where job_id = ${jobId}`;
    if (action === 'cancel') await tx`delete from crew_text_log where job_id = ${jobId}`;
    const seen = new Set();
    return notified.filter(r => !seen.has(r.worker_key) && seen.add(r.worker_key)).map(r => ({ contactId: r.contact_id, workerName: r.worker_name, workerPhone: r.worker_phone }));
  });
  if (!told.length) return { removed: 0 };
  const state = await jobState(sql, jobId);
  const effectId = `cancel:workers:${jobId}:${Date.now().toString(36)}`;
  const payload = { action: 'remove', jobId, opportunityId: jobId, jobAddress: state?.jobAddress || '', removedWorkers: told, reason: 'cancelled', jobCancelled: true, timeZone: 'America/Los_Angeles' };
  await sql`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values (${effectId}, ${effectId}, 'workers', ${effectId}, 'sending', ${sql.json(payload)})`;
  const ok = await deliverEffect(sql, { effect_id: effectId, kind: 'workers', payload });
  return { removed: told.length, ok };
}
// EOD sheet sent: that day is over for the crew. Their records for it stop counting, so
// next day's changes start fresh.
export async function endJobDay(sql, jobId, date) {
  if (!isDate(date)) return;
  await ensureHoldTables(sql);
  await sql`update crew_notify set notified = false, updated_at = now() where job_id = ${String(jobId)} and report_date <= ${date} and notified = true`;
}

// ---------- The timer ----------
// Every job with waiting runs and when it goes out.
export async function holdSchedule(sql) {
  const rows = (await sql`select effect_id, kind, payload from dispatch_effects where status = 'nightly' order by created_at, effect_id`).map(r => ({ ...r, payload: asJson(r.payload) }));
  const byJob = new Map();
  for (const r of rows) { const id = String(r.payload.jobId || ''); if (!id) continue; if (!byJob.has(id)) byJob.set(id, []); byJob.get(id).push(r); }
  if (!byJob.size) return [];
  const states = new Map((await sql`select job_id, data, active from job_shared_state where job_id = any(${[...byJob.keys()]})`).map(r => [r.job_id, { ...asJson(r.data), active: r.active }]));
  return [...byJob].map(([jobId, list]) => {
    const state = states.get(jobId);
    return { jobId, rows: list, dueAt: state && state.active !== false ? dueAtFor(state, list) : null, start: state ? jobStartUtc(state.reportDate, state.reportTime) : null };
  });
}
export async function nextDueAt(sql) {
  const due = (await holdSchedule(sql)).map(j => j.dueAt).filter(v => v != null);
  return due.length ? Math.min(...due) : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Sends every job whose 12 hours have been reached, earliest first, one job every 15 s.
export async function runDue(sql, { now = () => Date.now(), gapMs = BATCH_GAP_MS, deadline = Infinity, log = console.log } = {}) {
  const out = [];
  const due = (await holdSchedule(sql)).filter(j => j.dueAt != null && j.dueAt <= now() + 1000).sort((a, b) => a.dueAt - b.dueAt);
  for (const j of due) {
    if (out.length) { if (now() + gapMs > deadline) break; await sleep(gapMs); }
    try { out.push(await syncJob(sql, j.jobId, { mode: 'due', why: 'hold' })); }
    catch (error) { out.push({ jobId: j.jobId, error: error.message }); }
    log('crew hold sent', JSON.stringify(out[out.length - 1]));
  }
  return out;
}

// ---------- For the board ----------
// Per job: how many crew changes are waiting, for whom, and when they go out.
export async function waitingSummary(sql) {
  const jobs = {};
  for (const j of await holdSchedule(sql)) {
    const entry = { changes: j.rows.length, names: [], dueAt: j.dueAt ? new Date(j.dueAt).toISOString() : '' };
    for (const r of j.rows) for (const w of rowWorkers(r.payload)) { const n = String(w.workerName || '').trim(); if (n && !entry.names.includes(n)) entry.names.push(n); }
    jobs[j.jobId] = entry;
  }
  return { jobs, holdHours: holdHours() };
}

// ---------- Times changed after the crew was sent the job ----------
// Workers who were already sent this job (inside the 12 hours or Send schedule now) and
// are still on it. The board asks this after new times are saved, to offer a new text.
export async function notifiedOnJob(sql, jobId, { now = Date.now() } = {}) {
  jobId = String(jobId);
  await ensureHoldTables(sql);
  const today = pacificParts(now).date;
  const state = await jobState(sql, jobId);
  if (!state || state.active === false) return [];
  const crew = crewOfState(state);
  const ledger = (await ledgerOn(sql, jobId)).filter(r => r.report_date >= today);
  return crew.filter(w => ledger.some(r => r.worker_key === workerKey(w))).map(workerFields);
}
// Dispatch picked "Text the new times": each of those workers gets a fresh assign run
// (timesChanged: true, with the old times) and the schedule text again with the new times.
// Once per job per set of times: a double click or a second board sends nothing more.
export async function resendTimes(sql, jobId, { previous = {}, now = Date.now(), by = '' } = {}) {
  jobId = String(jobId);
  await ensureHoldTables(sql);
  const today = pacificParts(now).date;
  const plan = await sql.begin(async tx => {
    await lockJob(tx, jobId);
    const state = await jobState(tx, jobId);
    if (!state || state.active === false) return null;
    const date = isDate(state.reportDate) ? state.reportDate : '';
    const sig = [date, state.reportTime || '', state.reportEndDate || '', state.reportEndTime || '', state.nightWork ? 'n' : 'd'].join('|');
    const claimed = await tx`insert into dispatch_settings (key, value, updated_by) values (${`times-resend:${jobId}:${sig}`}, ${tx.json({ at: new Date(now).toISOString(), by })}, ${String(by).slice(0, 120)}) on conflict (key) do nothing returning key`;
    if (!claimed.length) return { duplicate: true };
    const ledger = (await ledgerOn(tx, jobId)).filter(r => r.report_date >= today);
    const workers = crewOfState(state).filter(w => ledger.some(r => r.worker_key === workerKey(w)));
    const out = [];
    for (const w of workers) {
      const key = workerKey(w), f = workerFields(w);
      const lastId = ledger.find(r => r.worker_key === key)?.effect_id || '';
      const [last] = lastId ? await tx`select payload from dispatch_effects where effect_id = ${lastId}` : [];
      const prev = last ? asJson(last.payload) : {};
      const base = ['assign', 'rapid_assign'].includes(prev.action) ? prev : {
        jobId, jobAddress: state.jobAddress || '', clientName: state.clientName || '', clientPhone: state.clientPhone || '', scopeOfWork: state.scopeOfWork || '',
        toolsRequired: state.toolsRequired || '', monetaryValue: state.monetaryValue ?? null, timeZone: 'America/Los_Angeles'
      };
      let payload = { ...base, ...f, action: 'assign', rapidAssign: false, assignedWorkers: [f], workerIndex: 1, workerCount: 1,
        timesChanged: true, previousReportDate: String(previous.reportDate || ''), previousReportTime: String(previous.reportTime || ''),
        previousReportEndDate: String(previous.reportEndDate || ''), previousReportEndTime: String(previous.reportEndTime || '') };
      payload = refreshAssign(payload, state);
      if (payload.customTime && date) payload.workerReportDate = date;
      const effectId = `times:${jobId}:${key.replace(/[^\w]/g, '')}:${Date.now().toString(36)}`;
      await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values (${effectId}, ${effectId}, 'workers', ${effectId}, 'sending', ${tx.json(payload)})`;
      if (date) await markNotified(tx, jobId, date, w, effectId);
      // Their earlier text had the old times: let the new one go out.
      const phone = toE164(f.workerPhone);
      if (phone) await tx`delete from crew_text_log where job_id = ${jobId} and phone = ${phone} and report_date >= ${today}`;
      // A waiting run for them is replaced by this one.
      for (const r of (await heldRows(tx, jobId)).filter(r => r.payload.action !== 'remove' && rowWorkers(r.payload).some(x => sameWorker(x, w))))
        await tx`update dispatch_effects set status = 'cancelled', last_error = 'Replaced by the new times text', updated_at = now() where effect_id = ${r.effect_id} and status = 'nightly'`;
      out.push({ effect_id: effectId, kind: 'workers', payload });
    }
    return { out };
  });
  if (!plan) return { ok: false, skipped: 'closed', makeSent: 0, texted: 0 };
  if (plan.duplicate) return { ok: true, duplicate: true, makeSent: 0, texted: 0 };
  const results = await Promise.all(plan.out.map(row => deliverEffect(sql, row)));
  const t = await textJob(sql, jobId, 'times_changed');
  return { ok: results.every(Boolean) && t.ok, makeSent: results.filter(Boolean).length, makeFailed: results.filter(r => !r).length, texted: t.texted };
}
