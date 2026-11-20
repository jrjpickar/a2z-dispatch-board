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
import { pacificToUtc, toE164, identityRank, matchWorker, effectiveWorkerTimes, ensureTable as ensureTextTables, fillScheduleState } from './crew-text.mjs';
import { logActivity, scheduleActivity } from './activity.mjs';
import { StateError } from './state.mjs';
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
export function pacificIso(ms) {
  const p = pacificParts(ms);
  const time = [p.hour, p.minute].map(n => String(n).padStart(2, '0')).join(':');
  const minutes = Math.round((Date.parse(p.date + 'T' + time + ':00Z') - ms) / 60000);
  const offset = [Math.floor(Math.abs(minutes) / 60), Math.abs(minutes) % 60].map(n => String(n).padStart(2, '0')).join(':');
  const secs = new Date(ms).toISOString().slice(17, 23);
  return `${p.date}T${time}:${secs}${minutes < 0 ? '-' : '+'}${offset}`;
}

function earliestStart(state, payload = {}, includeWorker = false) {
  return [jobStartUtc(state?.reportDate, state?.reportTime),
    jobStartUtc(payload.reportDate2, payload.reportTime2),
    ...(includeWorker ? [jobStartUtc(payload.workerReportDate, payload.workerReportTime),
      jobStartUtc(payload.workerReportDate2, payload.workerReportTime2)] : [])].filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
}

export function textPlan(state, payload = {}, now = Date.now()) {
  const textAtMode = payload.textAtMode || 'default';
  if (!['default', 'now', 'custom'].includes(textAtMode)) throw new StateError('Pick a valid Text at option.');
  const start = earliestStart(state, payload, textAtMode === 'custom');
  let due = start == null ? null : start - holdHours() * 3600e3;
  if (textAtMode === 'now') due = now;
  if (textAtMode === 'custom') {
    due = Date.parse(payload.textAt || '');
    const wall = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):(?:00|15|30|45):00(?:\.000)?-0[78]:00$/;
    if (!wall.test(payload.textAt || '') || !Number.isFinite(due) || pacificIso(due).replace('.000', '') !== payload.textAt.replace('.000', ''))
      throw new StateError('Pick a valid Pacific date and quarter hour for Text at.');
    if (start == null || due > start) throw new StateError('Text at must be at or before the job starts.');
  }
  return { textAtMode, textAt: due == null ? '' : pacificIso(Math.max(due, now)) };
}

export function rowDueAt(state, row) {
  const p = row.payload || {};
  if (p.action === 'remove') return null;
  if (p.textAtMode === 'now' && Number.isFinite(Date.parse(p.textAt))) return Date.parse(p.textAt);
  const customMode = p.textAtMode === 'custom';
  const worker = customMode && matchWorker(crewOfState(state), p);
  const own = worker ? effectiveWorkerTimes(state, worker) : p.workerTimes;
  const start = earliestStart(state, {
    ...(p.action === 'split_day_assign' ? p : {}),
    workerReportDate: own?.reportDate, workerReportTime: own?.reportTime
  }, customMode);
  if (start == null) return null;
  const custom = p.textAtMode === 'custom' ? new Date(row.send_at || p.textAt).getTime() : NaN;
  return Number.isFinite(custom) ? Math.min(custom, start) : start - holdHours() * 3600e3;
}

export function dueAtFor(state, rows = []) {
  const due = (rows.length ? rows : [{}]).map(r => rowDueAt(state, r)).filter(Number.isFinite);
  return due.length ? Math.min(...due) : null;
}

export async function logScheduleWorkers(sql, session, action, state, workers, { now = Date.now(), force = false, note = '', workerSkips = [] } = {}) {
  for (const w of workers) {
    const skip = workerSkips.find(x => x.key === workerKey(w));
    const reason = skip?.reason || (w.dontText ? "Don't text" : note);
    const chosen = action.startsWith('Assigned') ? Date.parse(w.textAt) : NaN;
    const due = force ? now : Number.isFinite(chosen) ? chosen : rowDueAt(state, { payload: w });
    const times = effectiveWorkerTimes(state, w);
    const entry = scheduleActivity(action, state, w, times, reason || due == null ? '' : pacificIso(Math.max(now, due)), reason);
    await logActivity(sql, session, entry.action, entry.target, entry.detail);
  }
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
export function workerKey(w) {
  if (w?.contactId || w?.id) return 'c:' + (w.contactId || w.id);
  const phone = toE164(w?.workerPhone || w?.phone);
  if (phone) return 'p:' + phone;
  return 'n:' + String(w?.workerName || w?.name || '').trim().toLowerCase();
}
export const sameWorker = (a, b) => identityRank(a, b) > 0;
// The workers a run is about.
export function rowWorkers(payload) {
  if (payload.action === 'remove') return (Array.isArray(payload.removedWorkers) ? payload.removedWorkers : []).filter(w => w && (w.workerName || w.workerPhone));
  return [{ contactId: payload.contactId || '', workerName: payload.workerName || '', workerPhone: payload.workerPhone || '' }];
}
const workerFields = w => ({ contactId: String(w.contactId || w.id || ''), workerName: String(w.workerName || w.name || ''), workerPhone: String(w.workerPhone || w.phone || '') });
// Is this crew_notify row about worker w? Same key first. The key is built from the run
// payload, which can carry a phone the crew entry doesn't (or the other way round), so
// phone, contact id and name are checked too. Two different phones are never the same worker.
function ledgerWorker(r) {
  const key = String(r.worker_key || '');
  return { id: r.contact_id || (key.startsWith('c:') ? key.slice(2) : ''),
    phone: r.worker_phone || (key.startsWith('p:') ? key.slice(2) : ''),
    name: r.worker_name || (key.startsWith('n:') ? key.slice(2) : '') };
}
export function ledgerMatch(r, w, crew = [w]) {
  return !!r && !!w && matchWorker(crew, ledgerWorker(r)) === w;
}
export function workerLedger(ledger, w, crew) {
  return ledger.filter(r => ledgerMatch(r, w, crew))
    .sort((a, b) => identityRank(ledgerWorker(b), w) - identityRank(ledgerWorker(a), w)
      || String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
      || String(a.worker_key).localeCompare(String(b.worker_key)))[0];
}
export const skippedWorker = (skips, w, crew) => w.dontText === true || skips.some(s => ledgerMatch(s, w, crew));

// An assign run goes out with the job's times as they are now.
export function refreshAssign(payload, state) {
  if (!state || !['assign', 'rapid_assign', 'split_day_assign'].includes(payload.action)) return payload;
  const night = state.nightWork === true || state.nightWork === 'true';
  const next = { ...payload };
  for (const k of ['reportDate', 'reportTime', 'reportEndDate', 'reportEndTime']) if (Object.hasOwn(state, k)) next[k] = state[k] || '';
  if (Object.hasOwn(state, 'nightWork')) { next.nightWork = night; next.shiftType = night ? 'night' : 'day'; }
  const worker = matchWorker(crewOfState(state), payload);
  if (worker?.workerTimes || !payload.customTime) {
    const t = effectiveWorkerTimes(next, worker);
    Object.assign(next, { workerReportDate: t.reportDate, workerReportTime: t.reportTime,
      workerReportEndDate: t.reportEndDate, workerReportEndTime: t.reportEndTime, customTime: t.customTime });
  } else if (next.reportDate && payload.workerReportDate && next.reportDate !== payload.workerReportDate) {
    const t = effectiveWorkerTimes(next, { workerTimes: {
      reportDate: payload.workerReportDate, reportTime: payload.workerReportTime,
      reportEndDate: payload.workerReportEndDate, reportEndTime: payload.workerReportEndTime, customTime: true
    } });
    next.workerReportDate = t.reportDate;
    next.workerReportEndDate = t.reportEndDate;
  }
  if (payload.action === 'split_day_assign') for (const field of SCHEDULE_FIELDS) next[field + '1'] = next[field];
  return next;
}

const SCHEDULE_FIELDS = ['reportDate', 'reportTime', 'reportEndDate', 'reportEndTime', 'nightWork', 'shiftType',
  'workerReportDate', 'workerReportTime', 'workerReportEndDate', 'workerReportEndTime', 'customTime'];

export function refreshSplitSecond(payload, state) {
  if (payload.action !== 'split_day_assign' || !state) return payload;
  const next = { ...payload };
  const other = refreshAssign({ ...workerFields(payload), action: 'assign',
    ...Object.fromEntries(SCHEDULE_FIELDS.map(k => [k, payload[k + '2']])) }, state);
  for (const field of SCHEDULE_FIELDS) next[field + '2'] = other[field];
  return next;
}

// ---------- The decision (pure, tested on its own) ----------
// rows: held runs for one job, oldest first ({ effect_id, kind, payload }).
// crew: the job's crew now. date: the job's day. ledger: crew_notify rows that are on.
// mode 'due' (12 hours reached, or Send now): everything is settled.
// mode 'removes' (before the 12 hours): only removes of notified workers go out.
// Returns { send: [{ row, payload, action, workers }], drop: [effect_id], keep: [effect_id] }.
export function decide(rows, { crew = [], date = '', ledger = [], today, mode = 'due', eligible = () => true }) {
  const byWorker = new Map();
  for (const row of rows) for (const w of rowWorkers(row.payload)) {
    const key = workerKey(matchWorker(crew, w) || w);
    if (!byWorker.has(key)) byWorker.set(key, { worker: w, events: [] });
    byWorker.get(key).events.push({ row, type: row.payload.action === 'remove' ? 'remove' : 'assign', worker: w });
  }
  const future = new Set();
  const chosen = new Map(); // effect_id -> { row, action, workers }
  for (const [key, { worker, events }] of byWorker) {
    const member = matchWorker(crew, worker);
    const onCrew = !!member;
    const notifiedDay = !!date && ledger.some(r => r.report_date === date && ledgerMatch(r, matchWorker(crew, worker) || worker, onCrew ? crew : [worker]));
    const notifiedAny = ledger.some(r => r.report_date >= today && ledgerMatch(r, matchWorker(crew, worker) || worker, onCrew ? crew : [worker]));
    let action = null;
    if (!onCrew && notifiedAny) action = 'remove';
    else if (mode === 'due' && onCrew && !member.dontText && !notifiedDay && date) action = 'assign';
    if (!action) continue;
    const last = [...events].reverse().find(e => e.type === action);
    if (!last) continue; // e.g. removed with Don't text: no remove run was asked for
    if (action === 'assign' && !eligible(last.row)) { future.add(last.row.effect_id); continue; }
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
  const keep = rest.filter(r => mode === 'due' ? future.has(r.effect_id) : r.payload.action !== 'remove').map(r => r.effect_id);
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
  await sql`alter table dispatch_effects add column if not exists send_at timestamptz`;
  await sql`create index if not exists dispatch_effects_waiting_idx on dispatch_effects ((payload->>'jobId')) where status = 'nightly'`;
  // Workers put on a job with "Don't text workers" (so the text tracker can tell that apart from a missed text).
  await sql`create table if not exists crew_text_skip (
    job_id text not null, report_date text not null, worker_key text not null, worker_name text not null default '',
    skipped_by text not null default '', created_at timestamptz not null default now(),
    primary key (job_id, report_date, worker_key))`;
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
// The job's date comes from its saved times, or (never saved on the board) from the
// newest assign run the board sent with the GHL date (crew-text.mjs fillRunDates).
export async function jobState(sql, jobId) {
  const [row] = await sql`select data, active from job_shared_state where job_id = ${String(jobId)}`;
  if (!row) return null;
  const states = await fillScheduleState(sql, new Map([[String(jobId), asJson(row.data)]]));
  return { ...states.get(String(jobId)), active: row.active };
}
async function skipsFor(sql, jobId, date) {
  return sql`select worker_key, worker_name from crew_text_skip where job_id = ${String(jobId)} and report_date = ${String(date)}`;
}
const skipped = skippedWorker;
// Sent this job for another day (the date moved, or the crew was kept on for a new day)
// and never sent the job's current day.
export const carriedOver = (ledger, w, date, crew = [w]) => !!date && !workerLedger(ledger.filter(r => r.report_date === date), w, crew) && !!workerLedger(ledger.filter(r => r.report_date !== date), w, crew);
// Job fields for a fresh assign run (no worker or custom time fields from another run).
const JOB_FIELDS = ['jobId', 'opportunityId', 'jobAddress', 'clientName', 'clientPhone', 'scopeOfWork', 'toolsRequired', 'monetaryValue', 'timeZone'];
async function jobBase(tx, jobId, state) {
  const [last] = await tx`select payload from dispatch_effects where kind = 'workers' and payload->>'jobId' = ${jobId} and payload->>'action' in ('assign', 'rapid_assign') order by created_at desc limit 1`;
  const p = last ? asJson(last.payload) : {};
  const base = { jobId, opportunityId: jobId, jobAddress: state.jobAddress || '', clientName: state.clientName || '', clientPhone: state.clientPhone || '',
    scopeOfWork: state.scopeOfWork || '', toolsRequired: state.toolsRequired || '', monetaryValue: state.monetaryValue ?? null, timeZone: 'America/Los_Angeles' };
  for (const k of JOB_FIELDS) if (p[k] != null && p[k] !== '' && k !== 'jobId') base[k] = p[k];
  return base;
}
async function heldRows(sql, jobId) {
  return (await sql`select effect_id, kind, payload, send_at, created_at from dispatch_effects where status = 'nightly' and payload->>'jobId' = ${String(jobId)} order by created_at, effect_id`)
    .map(r => ({ ...r, payload: asJson(r.payload) }));
}
async function ledgerOn(sql, jobId) {
  return sql`select report_date, worker_key, worker_name, worker_phone, contact_id, effect_id, updated_at from crew_notify where job_id = ${String(jobId)} and notified = true`;
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
  const crew = [...crewOfState(await jobState(tx, jobId)), w];
  const keys = (await tx`select worker_key, worker_name, worker_phone, contact_id from crew_notify where job_id = ${String(jobId)} and report_date >= ${today}`)
    .filter(r => ledgerMatch(r, w, crew)).map(r => r.worker_key);
  if (!keys.includes(workerKey(w))) keys.push(workerKey(w));
  await tx`update crew_notify set notified = false, effect_id = ${effectId}, updated_at = now() where job_id = ${String(jobId)} and worker_key = any(${keys}) and report_date >= ${today}`;
  // Told they're off: if they're put back later, they get the schedule text again.
  const phone = toE164(w.workerPhone || w.phone || '');
  if (phone) await tx`delete from crew_text_log where job_id = ${String(jobId)} and phone = ${phone} and report_date >= ${today}`;
}

// ---------- Sending one job ----------
// mode 'due': 12 hours reached (or Send now). mode 'removes': right after a remove, before the 12 hours.
// Text crew (job row dropdown): one crew member, held 5 seconds on the board and then
// confirmed. Works like Send now did, for that one worker:
//   * Make: their waiting assign (or split day) run goes to its webhook now. With none
//     waiting (put on with Don't text, or already sent), a fresh rapid_assign run goes to
//     the worker webhook, so the GHL appointment (and the job log texts it drives) is booked.
//   * They are marked notified, so taking them off later sends the remove run as before.
//   * The schedule text goes out (Twilio + GHL log), even if they already got it: their old
//     claim for the day is replaced.
export async function textWorkerNow(sql, jobId, worker = {}, { now = Date.now() } = {}) {
  jobId = String(jobId || '');
  await ensureTextTables(sql);
  const plan = await sql.begin(async tx => {
    await lockJob(tx, jobId);
    const state = await jobState(tx, jobId);
    if (!state || state.active === false) throw new StateError('This job is closed.', 409);
    const date = isDate(state.reportDate) ? state.reportDate : '';
    if (!date) throw new StateError('This job has no date. Save its times first.', 409);
    const crew = crewOfState(state);
    const onJob = matchWorker(crew, worker);
    if (!onJob) throw new StateError('That worker is not on this job anymore. Refresh the board.', 409);
    const f = workerFields(onJob);
    const phone = toE164(f.workerPhone || worker.workerPhone || worker.phone || '');
    if (!phone) throw new StateError(`${f.workerName || 'This worker'} has no phone number.`, 409);
    // Their newest waiting run for this job, if any (assign, rapid assign or split day).
    const held = (await heldRows(tx, jobId)).filter(r => r.payload.action !== 'remove' && rowWorkers(r.payload).some(w => matchWorker(crew, w) === onJob)).at(-1);
    let make;
    if (held && rowWorkers(held.payload).length === 1) {
      let payload = refreshAssign(held.payload, state);
      if (payload.textAtMode) payload = { ...payload, textAt: pacificIso(now), textAtMode: 'now' };
      payload = { ...payload, sentFrom: 'worker_text_now' };
      const claimed = await tx`update dispatch_effects set status = 'sending', payload = ${tx.json(payload)}, updated_at = now() where effect_id = ${held.effect_id} and status = 'nightly' returning effect_id`;
      if (claimed.length) {
        make = { effect_id: held.effect_id, kind: held.kind, payload };
        if (payload.action === 'split_day_assign' && payload.jobId2 && isDate(payload.reportDate2)) await markNotified(tx, payload.jobId2, payload.reportDate2, onJob, held.effect_id);
      }
    }
    if (!make) {
      const base = await jobBase(tx, jobId, state);
      const fields = { ...f, workerPhone: phone };
      const payload = refreshAssign({ ...base, ...fields, action: 'rapid_assign', rapidAssign: true, assignedWorkers: [fields], workerIndex: 1, workerCount: 1,
        textAtMode: 'now', textAt: pacificIso(now), sentFrom: 'worker_text_now' }, state);
      const effectId = newId('textnow-make', jobId);
      await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values (${effectId}, ${effectId}, 'workers', ${effectId}, 'sending', ${tx.json(payload)})`;
      make = { effect_id: effectId, kind: 'workers', payload };
    }
    await markNotified(tx, jobId, date, onJob, make.effect_id);
    // The text: replace any earlier claim for this job, day and phone, then queue it.
    await tx`delete from crew_text_log where job_id = ${jobId} and report_date = ${date} and phone = ${phone}`;
    const textId = newId('textnow', jobId);
    const text = { action: 'crewText', jobId, jobAddress: String(state.jobAddress || ''), reportDate: date, reportTime: String(state.reportTime || ''),
      timeZone: 'America/Los_Angeles', triggeredBy: 'worker_text_now', manual: true,
      textWorkers: [{ contactId: f.contactId, workerName: f.workerName, workerPhone: phone }] };
    await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values (${textId}, ${textId}, 'crew_text', ${textId}, 'sending', ${tx.json(text)})`;
    return { state, date, onJob, make, text: { effect_id: textId, kind: 'crew_text', payload: text } };
  });
  const [makeOk, textOk] = await Promise.all([deliverEffect(sql, plan.make), deliverEffect(sql, plan.text)]);
  return { ok: !!(makeOk && textOk), makeOk: !!makeOk, textOk: !!textOk, makeAction: plan.make.payload.action, worker: plan.onJob, state: plan.state, date: plan.date };
}

export async function sendJobScheduleNow(sql, jobId) {
  const related = (await holdSchedule(sql)).filter(j => j.jobId !== jobId && j.rows.some(r => r.payload.jobId2 === jobId));
  const workersForJob = row => row.payload.jobId2 === jobId;
  const results = [];
  for (const j of related) results.push(await syncJob(sql, j.jobId, { why: 'send_now', rowFilter: workersForJob }));
  const result = await syncJob(sql, jobId, { why: 'send_now' });
  for (const part of results) {
    result.makeSent += part.makeSent;
    result.makeFailed += part.makeFailed;
    result.texted += part.texted;
    result.textOk &&= part.textOk;
  }
  return result;
}

export async function syncJob(sql, jobId, { mode = 'due', now = Date.now(), why = 'hold', rowFilter } = {}) {
  jobId = String(jobId);
  const today = pacificParts(now).date;
  const plan = await sql.begin(async tx => {
    await lockJob(tx, jobId);
    const state = await jobState(tx, jobId);
    // Closed (or closing in its undo window): the cancel / complete settles it.
    if (!state || state.active === false) return null;
    const rows = await heldRows(tx, jobId);
    for (const row of rows) if (row.payload.action === 'split_day_assign' && row.payload.jobId2) {
      row.payload = refreshSplitSecond(row.payload, await jobState(tx, row.payload.jobId2));
    }
    const ledger = await ledgerOn(tx, jobId);
    const date = isDate(state.reportDate) ? state.reportDate : '';
    // No date anywhere: only removes of notified workers can go. Waiting assigns are kept
    // (they used to be dropped here, so Send now on such a job quietly lost them).
    const how = mode === 'due' && !date ? 'removes' : mode;
    const force = why === 'send_now';
    const crew = crewOfState(state);
    const skips = date ? await skipsFor(tx, jobId, date) : [];
    const eligible = row => force ? !rowFilter || rowFilter(row) : (rowDueAt(state, row) ?? Infinity) <= now;
    const { send, drop, keep } = decide(rowFilter ? rows.filter(rowFilter) : rows, { crew: crew.map(w => skipped(skips, w, crew) ? { ...w, dontText: true } : w), date, ledger, today, mode: how, eligible });
    if (drop.length) await tx`update dispatch_effects set status = 'cancelled', last_error = ${how === 'due' ? 'Nothing to send: canceled out or replaced before it went out' : 'Worker was not notified yet, so no remove run is needed'}, updated_at = now() where effect_id = any(${drop}) and status = 'nightly'`;
    const out = [];
    for (const s of send) {
      let payload = refreshAssign(s.payload, state);
      if (s.action === 'assign' && payload.textAtMode) {
        const textAt = force ? now : rowDueAt(state, s.row);
        payload = { ...payload, textAt: pacificIso(textAt ?? now), textAtMode: force ? 'now' : payload.textAtMode };
      }
      // Record who was told before anything is sent: a second caller sees it and sends nothing.
      if (s.action === 'remove') for (const w of s.workers) await markRemoved(tx, jobId, w, today, s.row.effect_id);
      else {
        for (const w of s.workers) await markNotified(tx, jobId, date, w, s.row.effect_id);
        if (s.row.payload.action === 'split_day_assign' && s.row.payload.jobId2 && isDate(s.row.payload.reportDate2)) for (const w of s.workers) await markNotified(tx, s.row.payload.jobId2, s.row.payload.reportDate2, w, s.row.effect_id);
      }
      const claimed = await tx`update dispatch_effects set status = 'sending', payload = ${tx.json(payload)}, updated_at = now() where effect_id = ${s.row.effect_id} and status = 'nightly' returning effect_id`;
      if (claimed.length) out.push({ effect_id: s.row.effect_id, kind: s.row.kind, payload });
    }
    // Crew still on the job with no run waiting and never sent this day: workers sent the
    // job for another day (date moved, crew kept on) get it now. Workers put on with Don't
    // text (no run, never sent) are only reported, never sent.
    const notQueued = [], noPhone = [];
    if (how === 'due' && !rowFilter) {
      const sentNow = new Set(send.filter(s => s.action === 'assign').flatMap(s => s.workers.map(w => w.key)));
      const recovery = why === 'send_now' ? await tx`select payload from dispatch_effects where payload->>'jobId' = ${jobId} and status = 'cancelled' and payload->>'action' in ('assign', 'rapid_assign', 'split_day_assign') order by created_at desc` : [];
      let base = null;
      for (const w of crewOfState(state)) {
        if (sentNow.has(workerKey(w))) continue;
        if (workerLedger(ledger.filter(r => r.report_date === date), w, crew)) continue;
        if (rows.some(r => keep.includes(r.effect_id) && matchWorker(crew, r.payload) === w)) continue;
        if (!force && (rowDueAt(state, { payload: w }) ?? Infinity) > now) continue;
        if (skipped(skips, w, crew)) continue;
        if (!carriedOver(ledger, w, date, crew) && !(force && (w.dontText === false || recovery.some(r => matchWorker(crew, asJson(r.payload)) === w)))) { notQueued.push(String(w.name)); continue; }
        const f = workerFields(w);
        if (!f.workerPhone) { const hit = workerLedger(ledger, w, crew); f.workerPhone = String(hit?.worker_phone || ''); if (!f.contactId) f.contactId = String(hit?.contact_id || ''); }
        if (!toE164(f.workerPhone)) { noPhone.push(String(w.name)); continue; }
        base ||= await jobBase(tx, jobId, state);
        const payload = refreshAssign({ ...base, ...f, action: 'assign', rapidAssign: false, assignedWorkers: [f], workerIndex: 1, workerCount: 1, newDay: true, sentFrom: why }, state);
        const effectId = newId('newday', jobId);
        await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values (${effectId}, ${effectId}, 'workers', ${effectId}, 'sending', ${tx.json(payload)})`;
        await markNotified(tx, jobId, date, w, effectId);
        out.push({ effect_id: effectId, kind: 'workers', payload });
      }
    }
    return { state, out, noDate: mode === 'due' && !date, notQueued, noPhone };
  });
  if (!plan) return { jobId, skipped: 'closed', makeSent: 0, makeFailed: 0, texted: 0, textOk: true };
  const results = await Promise.all(plan.out.map(row => deliverEffect(sql, row)));
  let texted = 0, textOk = true;
  const extra = { ...(plan.noDate ? { skipped: 'no_date' } : {}), ...(plan.notQueued.length ? { notQueued: plan.notQueued } : {}), ...(plan.noPhone.length ? { noPhone: plan.noPhone } : {}) };
  if (mode === 'due' && !plan.noDate && (!rowFilter || plan.out.length)) {
    const t = await textJob(sql, jobId, why, rowFilter ? plan.out.flatMap(row => rowWorkers(row.payload).map(workerKey)) : []);
    texted += t.texted; textOk = textOk && t.ok;
    if (t.workerSkips?.length) extra.workerSkips = t.workerSkips;
    // A split day worker also gets the other job's text.
    for (const row of plan.out) if (row.payload.action === 'split_day_assign' && row.payload.jobId2) { const t2 = await textJob(sql, row.payload.jobId2, why, rowWorkers(row.payload).map(workerKey)); texted += t2.texted; textOk = textOk && t2.ok; }
  }
  return { jobId, makeSent: results.filter(Boolean).length, makeFailed: results.filter(r => !r).length, texted, textOk, ...extra };
}

// Schedule text (that job only) to every worker on it who was notified for that day and
// hasn't gotten it. Workers assigned with Don't text are never notified, so never texted.
export async function textJob(sql, jobId, why = 'hold', keys = []) {
  jobId = String(jobId);
  const state = await jobState(sql, jobId);
  const date = state && state.active !== false && isDate(state.reportDate) ? state.reportDate : '';
  if (!date) return { texted: 0, ok: true };
  const ledger = (await ledgerOn(sql, jobId)).filter(r => r.report_date === date);
  const claims = new Map((await sql`select l.phone, e.status, l.effect_id = 'seed' or exists (
      select 1 from crew_text_sends s where s.effect_id = l.effect_id and s.phone = l.phone and s.step like 'sms:%'
    ) as sent from crew_text_log l left join dispatch_effects e on e.effect_id = l.effect_id
    where l.job_id = ${jobId} and l.report_date = ${date}`).map(row => [row.phone, row]));
  const textWorkers = [], workerSkips = [];
  const crew = crewOfState(state);
  const skips = await skipsFor(sql, jobId, date);
  for (const w of crew) {
    if (keys.length && !keys.includes(workerKey(w))) continue;
    const hit = workerLedger(ledger, w, crew);
    // The crew entry may have no phone while the run that notified them did: use that one.
    const f = workerFields(w);
    if (!f.workerPhone) f.workerPhone = String(hit?.worker_phone || '');
    if (!f.contactId) f.contactId = String(hit?.contact_id || '');
    const p = toE164(f.workerPhone);
    const claim = claims.get(p);
    const reason = skipped(skips, w, crew) ? "Don't text"
      : !p ? 'No phone on file'
      : crew.some(other => other !== w && toE164(other.phone || workerLedger(ledger, other, crew)?.worker_phone) === p) ? 'Phone is shared by multiple workers on this job'
      : claim?.sent ? 'Text already sent for this date'
      : claim?.status === 'sending' ? 'Text is already being sent'
      : claim ? 'An earlier text attempt needs attention in the Schedule text tracker'
      : !hit && ledger.some(r => identityRank(ledgerWorker(r), w) > 0) ? 'Assignment identity is ambiguous'
      : !hit ? 'No assignment notification found' : '';
    if (reason) { workerSkips.push({ name: w.name, key: workerKey(w), reason }); continue; }
    textWorkers.push(f);
  }
  if (!textWorkers.length) return { texted: 0, ok: true, workerSkips };
  const effectId = newId(`${why}:crew_text`, jobId);
  const payload = { action: 'crewText', jobId, jobAddress: state.jobAddress || '', reportDate: date, timeZone: 'America/Los_Angeles', triggeredBy: why, textWorkers };
  await sql`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values (${effectId}, ${effectId}, 'crew_text', ${effectId}, 'sending', ${sql.json(payload)})`;
  let texted = 0;
  const ok = await deliverEffect(sql, { effect_id: effectId, kind: 'crew_text', payload }, { onSent: result => { texted = result.sent; } });
  return { texted, ok, workerSkips };
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
    const crew = crewOfState(state);
    const member = matchWorker(crew, w);
    if (date && workerLedger(ledger.filter(r => r.report_date === date), member || w, member ? crew : [w])) {
      await tx`update dispatch_effects set status = 'cancelled', last_error = 'Already sent to this worker for this job and day: not sent twice', updated_at = now() where effect_id = ${effectId}`;
      return 'duplicate';
    }
    if (date) await markNotified(tx, jobId, date, w, effectId);
    if (payload.action === 'split_day_assign' && payload.jobId2 && isDate(payload.reportDate2)) await markNotified(tx, payload.jobId2, payload.reportDate2, w, effectId);
    const mine = (await heldRows(tx, jobId)).filter(r => rowWorkers(r.payload).some(x => member ? matchWorker(crew, x) === member : sameWorker(x, w)));
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
  const rows = (await sql`select effect_id, kind, payload, send_at, created_at from dispatch_effects where status = 'nightly' order by created_at, effect_id`).map(r => ({ ...r, payload: asJson(r.payload) }));
  const byJob = new Map();
  for (const r of rows) { const id = String(r.payload.jobId || ''); if (!id) continue; if (!byJob.has(id)) byJob.set(id, []); byJob.get(id).push(r); }
  if (!byJob.size) return [];
  const ids = [...new Set([...byJob.keys(), ...rows.map(r => r.payload.jobId2).filter(Boolean)])];
  const states = await fillScheduleState(sql, new Map((await sql`select job_id, data, active from job_shared_state where job_id = any(${ids})`).map(r => [r.job_id, { ...asJson(r.data), active: r.active }])));
  for (const r of rows) if (r.payload.jobId2) r.payload = refreshSplitSecond(r.payload, states.get(String(r.payload.jobId2)));
  return [...byJob].map(([jobId, list]) => {
    const state = states.get(jobId);
    return { jobId, rows: list.map(row => ({ ...row, dueAt: state ? rowDueAt(state, row) : null })), dueAt: state && state.active !== false ? dueAtFor(state, list) : null, start: state ? jobStartUtc(state.reportDate, state.reportTime) : null };
  });
}
export async function nextDueAt(sql) {
  const due = (await holdSchedule(sql)).map(j => j.dueAt).filter(v => v != null);
  return due.length ? Math.min(...due) : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Texts that are owed: the worker was sent the job (crew_notify) for the job's current day,
// is still on the crew, has a phone, and no schedule text was ever started for them. This
// happens when a send was cut off between the Make run and the text (function timeout,
// crash). Only for jobs that haven't started yet; older misses show in the text tracker.
// Also owed (resend: true): crew sent this job for another day and never for its current
// day (date moved, crew kept on), once the current day's 12 hour mark is reached. Without
// this nothing ever went out for the new day: no run was waiting, so no timer.
export async function owedTexts(sql, { now = Date.now(), graceMs = 120e3 } = {}) {
  const today = pacificParts(now).date;
  const notes = await sql`select n.job_id, n.report_date, n.worker_key, n.worker_name, n.worker_phone, n.contact_id, n.updated_at
    from crew_notify n join job_shared_state s on s.job_id = n.job_id
    where n.notified = true and s.active = true and n.report_date >= ${addDays(today, -14)}`;
  if (!notes.length) return [];
  await ensureTextTables(sql);
  const jobIds = [...new Set(notes.map(r => r.job_id))];
  const states = await fillScheduleState(sql, new Map((await sql`select job_id, data from job_shared_state where job_id = any(${jobIds})`).map(r => [r.job_id, asJson(r.data)])));
  const texted = new Set((await sql`select job_id, report_date, phone from crew_text_log where job_id = any(${jobIds})`).map(r => `${r.job_id}|${r.report_date}|${r.phone}`));
  const skips = await sql`select job_id, report_date, worker_key, worker_name from crew_text_skip where job_id = any(${jobIds})`;
  const byJob = new Map();
  const add = (jobId, date, start, name, resend) => {
    if (!byJob.has(jobId)) byJob.set(jobId, { jobId, date, start, workers: [], ...(resend ? { resend: true } : {}) });
    const j = byJob.get(jobId); if (resend) j.resend = true;
    if (!j.workers.includes(name)) j.workers.push(name);
  };
  for (const jobId of jobIds) {
    const state = states.get(jobId) || {};
    const date = String(state.reportDate || '');
    if (!isDate(date)) continue;
    const start = jobStartUtc(date, state.reportTime);
    if (start == null || start <= now) continue;
    const ledger = notes.filter(r => r.job_id === jobId);
    const jobSkips = skips.filter(k => k.job_id === jobId && k.report_date === date);
    const crew = crewOfState(state);
    for (const w of crew) {
      if (skipped(jobSkips, w, crew)) continue;
      const hit = workerLedger(ledger.filter(r => r.report_date === date), w, crew);
      if (hit) {
        if (now - new Date(hit.updated_at).getTime() < graceMs) continue; // the send that marked it may still be running
        const phone = toE164(w.phone || w.workerPhone || hit.worker_phone);
        if (!phone || texted.has(`${jobId}|${date}|${phone}`)) continue;
        add(jobId, date, start, String(w.name || hit.worker_name || ''), false);
      } else if (carriedOver(ledger, w, date, crew) && (rowDueAt(state, { payload: w }) ?? Infinity) <= now) {
        const old = workerLedger(ledger, w, crew);
        if (!toE164(w.phone || w.workerPhone || old?.worker_phone)) continue;
        add(jobId, date, start, String(w.name || ''), true);
      }
    }
  }
  return [...byJob.values()].sort((a, b) => a.start - b.start);
}
// Sends every job whose 12 hours have been reached, earliest first, one job every 15 s,
// then any owed text (see owedTexts). onJob runs after each job (the runner's heartbeat).
export async function runDue(sql, { now = () => Date.now(), gapMs = BATCH_GAP_MS, deadline = Infinity, log = console.log, onJob = async () => {} } = {}) {
  const out = [];
  const due = (await holdSchedule(sql)).filter(j => j.dueAt != null && j.dueAt <= now() + 1000).sort((a, b) => a.dueAt - b.dueAt);
  for (const j of due) {
    if (out.length) { if (now() + gapMs > deadline) break; await sleep(gapMs); }
    try { out.push(await syncJob(sql, j.jobId, { mode: 'due', why: 'hold', now: now() + 1000 })); }
    catch (error) { out.push({ jobId: j.jobId, error: error.message }); }
    log('crew hold sent', JSON.stringify(out[out.length - 1]));
    try { await onJob(); } catch {}
  }
  let owed = [];
  try { owed = await owedTexts(sql, { now: now() }); } catch (error) { log('crew hold owed check failed', error.message); }
  for (const j of owed) {
    if (out.some(o => o.jobId === j.jobId && !o.error)) continue;
    if (out.length) { if (now() + gapMs > deadline) break; await sleep(gapMs); }
    try {
      if (j.resend) out.push({ ...(await syncJob(sql, j.jobId, { mode: 'due', why: 'new_day', now: now() })), catchUp: true });
      else { const t = await textJob(sql, j.jobId, 'catch_up'); out.push({ jobId: j.jobId, catchUp: true, texted: t.texted, textOk: t.ok }); }
    }
    catch (error) { out.push({ jobId: j.jobId, catchUp: true, error: error.message }); }
    log('crew hold owed text', JSON.stringify(out[out.length - 1]));
    try { await onJob(); } catch {}
  }
  return out;
}

// ---------- For the board ----------
// Per job: how many crew changes are waiting, for whom, and when they go out.
export async function waitingSummary(sql) {
  const jobs = {};
  for (const j of await holdSchedule(sql)) {
    jobs[j.jobId] ||= { changes: 0, names: [], workers: [], dueAt: '' };
    jobs[j.jobId].changes += j.rows.length;
    for (const r of j.rows) for (const w of rowWorkers(r.payload)) {
      const name = String(w.workerName || '').trim();
      if (!name) continue;
      for (const id of [j.jobId, r.payload.jobId2].filter(Boolean)) {
        const entry = jobs[id] ||= { changes: 0, names: [], workers: [], dueAt: '' };
        if (id !== j.jobId) entry.changes++;
        if (!entry.names.includes(name)) entry.names.push(name);
        if (r.dueAt == null) continue;
        const dueAt = new Date(r.dueAt).toISOString();
        const key = workerKey(w);
        entry.workers = entry.workers.filter(worker => worker.key !== key);
        entry.workers.push({ name, key, dueAt });
        if (!entry.dueAt || dueAt < entry.dueAt) entry.dueAt = dueAt;
      }
    }
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
  return crew.filter(w => workerLedger(ledger, w, crew)).map(workerFields);
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
    const crew = crewOfState(state);
    const skips = await skipsFor(tx, jobId, date);
    const workers = crew.filter(w => workerLedger(ledger, w, crew) && !skipped(skips, w, crew));
    const out = [];
    for (const w of workers) {
      const f = workerFields(w);
      const lastId = workerLedger(ledger, w, crew)?.effect_id || '';
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
      if (payload.textAtMode) Object.assign(payload, { textAtMode: 'now', textAt: pacificIso(now) });
      const effectId = newId('times', jobId);
      await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values (${effectId}, ${effectId}, 'workers', ${effectId}, 'sending', ${tx.json(payload)})`;
      if (date) await markNotified(tx, jobId, date, w, effectId);
      // Their earlier text had the old times: let the new one go out.
      const phone = toE164(f.workerPhone);
      if (phone) await tx`delete from crew_text_log where job_id = ${jobId} and phone = ${phone} and report_date >= ${today}`;
      // A waiting run for them is replaced by this one.
      for (const r of (await heldRows(tx, jobId)).filter(r => r.payload.action !== 'remove' && matchWorker(crew, r.payload) === w))
        await tx`update dispatch_effects set status = 'cancelled', last_error = 'Replaced by the new times text', updated_at = now() where effect_id = ${r.effect_id} and status = 'nightly'`;
      out.push({ effect_id: effectId, kind: 'workers', payload });
    }
    return { out, state, workers };
  });
  if (!plan) return { ok: false, skipped: 'closed', makeSent: 0, texted: 0 };
  if (plan.duplicate) return { ok: true, duplicate: true, makeSent: 0, texted: 0 };
  const results = await Promise.all(plan.out.map(row => deliverEffect(sql, row)));
  const t = await textJob(sql, jobId, 'times_changed');
  await logScheduleWorkers(sql, { name: by }, 'Resent schedule', { ...plan.state, jobId }, plan.workers, { now, force: true, workerSkips: t.workerSkips });
  return { ok: results.every(Boolean) && t.ok, makeSent: results.filter(Boolean).length, makeFailed: results.filter(r => !r).length, texted: t.texted };
}

// ---------- "Don't text workers" ----------
// The board records who was put on a job without a text, so the text tracker can show
// "Don't text" instead of a missed text. Nothing is sent.
export async function recordDontText(sql, { jobId, reportDate, workers = [], by = '' } = {}) {
  jobId = String(jobId || '');
  if (!jobId || !isDate(reportDate)) return 0;
  await ensureHoldTables(sql);
  let n = 0;
  for (const w of (Array.isArray(workers) ? workers : []).slice(0, 40)) {
    if (!w || !(w.workerName || w.name || w.workerPhone || w.phone)) continue;
    const f = workerFields(w);
    await sql`insert into crew_text_skip (job_id, report_date, worker_key, worker_name, skipped_by) values (${jobId}, ${reportDate}, ${workerKey(w)}, ${f.workerName.slice(0, 120)}, ${String(by).slice(0, 120)})
      on conflict (job_id, report_date, worker_key) do update set skipped_by = excluded.skipped_by, created_at = now()`;
    n++;
  }
  return n;
}

// ---------- Text now (Admin > Schedule text tracker) ----------
// A senior admin sends the job to workers on the crew who never got it: each one not yet
// sent the job gets their assign run (job's current times) and everyone sent it but not
// texted gets the schedule text. Same records as every other send, so nobody gets it twice.
// keys: worker keys from the tracker (empty: everyone on the crew who is missing it).
export async function sendWorkersNow(sql, jobId, { keys = [], now = Date.now() } = {}) {
  jobId = String(jobId);
  await ensureHoldTables(sql);
  const plan = await sql.begin(async tx => {
    await lockJob(tx, jobId);
    const state = await jobState(tx, jobId);
    if (!state || state.active === false) return null;
    const date = isDate(state.reportDate) ? state.reportDate : '';
    if (!date) return { noDate: true };
    const ledger = (await ledgerOn(tx, jobId)).filter(r => r.report_date === date);
    const held = await heldRows(tx, jobId);
    const skips = await skipsFor(tx, jobId, date);
    const crew = crewOfState(state);
    const want = new Set((Array.isArray(keys) ? keys : []).map(String));
    const out = [];
    for (const w of crewOfState(state)) {
      if (want.size && !want.has(workerKey(w))) continue;
      if (skipped(skips, w, crew)) continue;
      if (workerLedger(ledger, w, crew)) continue; // already sent the job: only the text is missing
      const f = workerFields(w);
      if (!toE164(f.workerPhone)) continue;
      const mine = held.filter(r => r.payload.action === 'assign' && matchWorker(crew, r.payload) === w);
      const last = mine.length ? mine[mine.length - 1].payload : null;
      const base = last || {
        jobId, opportunityId: jobId, jobAddress: state.jobAddress || '', clientName: state.clientName || '', clientPhone: state.clientPhone || '',
        scopeOfWork: state.scopeOfWork || '', toolsRequired: state.toolsRequired || '', monetaryValue: state.monetaryValue ?? null, timeZone: 'America/Los_Angeles'
      };
      const payload = refreshAssign({ ...base, ...f, action: 'assign', rapidAssign: false, assignedWorkers: [f], workerIndex: 1, workerCount: 1, sentFrom: 'text_tracker' }, state);
      const effectId = newId('tracker', jobId);
      await tx`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values (${effectId}, ${effectId}, 'workers', ${effectId}, 'sending', ${tx.json(payload)})`;
      await markNotified(tx, jobId, date, w, effectId);
      for (const r of mine) await tx`update dispatch_effects set status = 'cancelled', last_error = 'Replaced by Text now (text tracker)', updated_at = now() where effect_id = ${r.effect_id} and status = 'nightly'`;
      out.push({ effect_id: effectId, kind: 'workers', payload });
    }
    return { out };
  });
  if (!plan) return { ok: false, skipped: 'closed', makeSent: 0, makeFailed: 0, texted: 0 };
  if (plan.noDate) return { ok: false, skipped: 'no_date', makeSent: 0, makeFailed: 0, texted: 0 };
  const results = await Promise.all(plan.out.map(row => deliverEffect(sql, row)));
  const t = await textJob(sql, jobId, 'text_now', keys);
  return { ok: results.every(Boolean) && t.ok, makeSent: results.filter(Boolean).length, makeFailed: results.filter(r => !r).length, texted: t.texted };
}
