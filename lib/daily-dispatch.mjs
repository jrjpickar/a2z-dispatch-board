// Daily 6:30 PM dispatch (Pacific).
//
// Assign and remove worker runs to Make (worker webhook, and the split day webhook
// for split day assigns) are NOT sent when dispatch clicks. They wait (status
// 'nightly') until 6:30 PM every day, or until Send now is held on that job's row.
// Send schedule now in the crew picker still sends right away, as before.
//
// At 6:30 PM (or on Send now) each job goes out "how it sits at that point":
//   * per worker, only the net change since the last send: assigned and still on
//     the job = their assign run (with the job's current times), was on the job and
//     now off = their remove run, assigned then removed (or removed then put back)
//     before it went out = nothing;
//   * the schedule text (that job only) to every worker on it who hasn't gotten it
//     for that day. The 6:30 PM run texts tomorrow's jobs; Send now texts that job.
// The 6:30 PM run sends one job (one batch of workers) every 15 seconds.
import { toE164, pacificToUtc, loadDay, textedPhones } from './crew-text.mjs';
import { deliverEffect } from './effect-queue.mjs';

export const DISPATCH_HOUR = 18, DISPATCH_MINUTE = 30; // 6:30 PM Pacific
export const BATCH_GAP_MS = 15000;
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
// The next 6:30 PM Pacific after `now` (for the board's "goes out at" wording).
export function nextDispatchUtc(now = Date.now()) {
  const { date } = pacificParts(now);
  const today = pacificToUtc(date, '18:30');
  return now < today ? today : pacificToUtc(addDays(date, 1), '18:30');
}

// Which runs wait for 6:30 PM: assign / remove / split day assign on the worker
// webhooks. Send schedule now (rapid_assign, sendNow) goes right away.
export function waitsForNightly(kind, payload) {
  if (!HELD_KINDS.includes(kind) || !payload) return false;
  if (payload.rapidAssign === true || payload.sendNow === true || payload.action === 'rapid_assign') return false;
  return HELD_ACTIONS.includes(String(payload.action || ''));
}

// ---------- Net change per worker ----------
const digits = v => String(v || '').replace(/\D/g, '').slice(-10);
export function workerKey(w) {
  const phone = digits(w?.workerPhone || w?.phone);
  if (phone) return 'p:' + phone;
  if (w?.contactId || w?.id) return 'c:' + (w.contactId || w.id);
  return 'n:' + String(w?.workerName || w?.name || '').trim().toLowerCase();
}
function sameWorker(a, b) {
  const pa = digits(a.workerPhone || a.phone), pb = digits(b.workerPhone || b.phone);
  if (pa && pb) return pa === pb;
  const ca = a.contactId || a.id, cb = b.contactId || b.id;
  if (ca && cb) return ca === cb;
  return String(a.workerName || a.name || '').trim().toLowerCase() === String(b.workerName || b.name || '').trim().toLowerCase();
}
// The workers a held run is about.
function rowWorkers(payload) {
  if (payload.action === 'remove') return (Array.isArray(payload.removedWorkers) ? payload.removedWorkers : []).filter(w => w && (w.workerName || w.workerPhone));
  return [{ contactId: payload.contactId || '', workerName: payload.workerName || '', workerPhone: payload.workerPhone || '' }];
}
// rows: held runs for one job, oldest first ({ effect_id, payload }). crew: the job's crew now.
// Returns { send: [{ row, payload }], drop: [effect_id] }.
export function netChanges(rows, crew) {
  const byWorker = new Map();
  for (const row of rows) for (const w of rowWorkers(row.payload)) {
    const key = workerKey(w);
    if (!byWorker.has(key)) byWorker.set(key, { worker: w, events: [] });
    byWorker.get(key).events.push({ row, type: row.payload.action === 'remove' ? 'remove' : 'assign', worker: w });
  }
  const chosen = new Map(); // effect_id -> { row, workers: [] }
  for (const { worker, events } of byWorker.values()) {
    const wasOn = events[0].type === 'remove';
    const isOn = (crew || []).some(c => sameWorker(c, worker));
    if (wasOn === isOn) continue; // no net change: nothing goes to Make for them
    const want = isOn ? 'assign' : 'remove';
    const last = [...events].reverse().find(e => e.type === want);
    if (!last) continue;
    if (!chosen.has(last.row.effect_id)) chosen.set(last.row.effect_id, { row: last.row, workers: [] });
    chosen.get(last.row.effect_id).workers.push(last.worker);
  }
  const send = [...chosen.values()].map(({ row, workers }) => {
    if (row.payload.action !== 'remove') return { row, payload: row.payload };
    // A remove run for several workers (Unschedule) only carries the ones still off.
    const all = rowWorkers(row.payload);
    return { row, payload: workers.length === all.length ? row.payload : { ...row.payload, removedWorkers: workers } };
  });
  const sentIds = new Set(send.map(s => s.row.effect_id));
  return { send, drop: rows.map(r => r.effect_id).filter(id => !sentIds.has(id)) };
}
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

// ---------- Running a job ----------
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
const newId = (tag, jobId) => `${tag}:${jobId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Sends one job: its net Make changes, then the schedule text to anyone on it who
// hasn't gotten it for that day (textDate: the day to text, or null for none).
export async function sendJob(sql, jobId, { textDate, why = 'send_now' } = {}) {
  const state = await jobState(sql, jobId);
  const rows = await heldRows(sql, jobId);
  const { send, drop } = netChanges(rows, state?.active === false ? [] : crewOfState(state));
  if (drop.length) await sql`update dispatch_effects set status = 'cancelled', last_error = 'No change to send: canceled out or replaced before it went out', updated_at = now() where effect_id = any(${drop}) and status = 'nightly'`;
  const results = await Promise.all(send.map(async ({ row, payload }) => {
    const out = refreshAssign(payload, state);
    const claimed = await sql`update dispatch_effects set status = 'sending', payload = ${sql.json(out)}, updated_at = now() where effect_id = ${row.effect_id} and status = 'nightly' returning effect_id`;
    if (!claimed.length) return null; // someone else already sent it
    return deliverEffect(sql, { effect_id: row.effect_id, kind: row.kind, payload: out });
  }));
  let texted = 0, textOk = true;
  const date = textDate === undefined ? String(state?.reportDate || '') : textDate;
  if (date && state && state.active !== false) {
    const already = await textedPhones(sql, jobId, date);
    const day = await loadDay(sql, date);
    const job = (day.jobs || []).find(j => j.jobId === String(jobId));
    const textWorkers = (job?.workers || []).filter(w => !already.has(w.phone)).map(w => ({ contactId: w.contactId, workerName: w.name, workerPhone: w.phone }));
    if (textWorkers.length) {
      const effectId = newId(`${why}:crew_text`, jobId);
      const payload = { action: 'crewText', jobId: String(jobId), jobAddress: state.jobAddress || '', reportDate: date, timeZone: 'America/Los_Angeles', triggeredBy: why, textWorkers };
      await sql`insert into dispatch_effects (effect_id, request_id, kind, fingerprint, status, payload) values (${effectId}, ${effectId}, 'crew_text', ${effectId}, 'sending', ${sql.json(payload)})`;
      textOk = await deliverEffect(sql, { effect_id: effectId, kind: 'crew_text', payload });
      texted = textWorkers.length;
    }
  }
  const made = results.filter(r => r !== null);
  return { jobId: String(jobId), makeSent: made.filter(Boolean).length, makeFailed: made.filter(r => r === false).length, makeDropped: drop.length, texted, textOk };
}

// ---------- The 6:30 PM run ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Jobs with held Make runs, plus tomorrow's jobs with crew; tomorrow's first, by start time.
export async function nightlyJobs(sql, tomorrow) {
  const held = (await sql`select distinct payload->>'jobId' as job_id from dispatch_effects where status = 'nightly'`).map(r => r.job_id).filter(Boolean);
  const rows = await sql`select job_id, data from job_shared_state where active = true`;
  const states = new Map(rows.map(r => [r.job_id, asJson(r.data)]));
  const ids = new Set(held);
  for (const [id, s] of states) if (s.reportDate === tomorrow && crewOfState(s).length) ids.add(id);
  const startOf = id => { const s = states.get(id) || {}; return `${s.reportDate === tomorrow ? 0 : 1} ${s.reportDate || '9999'} ${s.reportTime || '99:99'}`; };
  return [...ids].sort((a, b) => startOf(a).localeCompare(startOf(b)));
}
// Claims the day's run once (two triggers can't both send it).
export async function claimNightly(sql, date) {
  const key = `nightly-run:${date}`;
  const got = await sql`insert into dispatch_settings (key, value, updated_by) values (${key}, ${sql.json({ startedAt: new Date().toISOString() })}, 'nightly') on conflict (key) do nothing returning key`;
  return got.length > 0;
}
export async function runNightly(sql, { now = Date.now(), gapMs = BATCH_GAP_MS, log = console.log } = {}) {
  const tomorrow = addDays(pacificParts(now).date, 1);
  const jobs = await nightlyJobs(sql, tomorrow);
  const out = [];
  for (let i = 0; i < jobs.length; i++) {
    if (i) await sleep(gapMs); // one batch of workers every 15 seconds
    const state = await jobState(sql, jobs[i]);
    try { out.push(await sendJob(sql, jobs[i], { textDate: state?.reportDate === tomorrow ? tomorrow : null, why: 'nightly' })); }
    catch (error) { out.push({ jobId: jobs[i], error: error.message }); }
    log('nightly batch', JSON.stringify(out[out.length - 1]));
  }
  return { tomorrow, jobs: out };
}

// ---------- For the board ----------
// Per job: how many crew changes are waiting for 6:30 PM and for whom.
export async function waitingSummary(sql) {
  const rows = await sql`select payload from dispatch_effects where status = 'nightly' order by created_at`;
  const jobs = {};
  for (const r of rows) {
    const p = asJson(r.payload); const id = String(p.jobId || ''); if (!id) continue;
    const j = jobs[id] || (jobs[id] = { changes: 0, names: [] });
    j.changes++;
    for (const w of rowWorkers(p)) { const n = String(w.workerName || '').trim(); if (n && !j.names.includes(n)) j.names.push(n); }
  }
  return { jobs, nextRun: new Date(nextDispatchUtc()).toISOString() };
}
