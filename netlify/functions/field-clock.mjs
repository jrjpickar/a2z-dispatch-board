// Field app clock in / clock out with location (lib/field-clock.mjs).
//   GET  /api/field-clock                     the signed-in worker's open shift and today's shifts
//   POST /api/field-clock { op: "clockIn",  jobId, requestId, location: { lat, lng, acc }, lang }
//   POST /api/field-clock { op: "clockOut", requestId, location, work, notes, lang }
//   POST /api/field-clock { op: "ping", location }   live location while on the clock (no Make run)
// Uses the field app's sign-in token (Authorization: Bearer), like driver-stop-action.
// Clock in / clock out each queue one run to the clock webhook in Make, sent in the
// background so the worker never waits on Make. A run Make doesn't confirm shows
// under Admin > Make / GHL problems with Retry, like every other webhook.
import { db, ensureSchema } from './db.mjs';
import { json, readPayload, errorResponse } from '../../lib/http.mjs';
import { driverIdentityFromRequest, matchesWorker } from '../../lib/driver-token.mjs';
import { jobRecord } from '../../lib/store.mjs';
import { StateError } from '../../lib/state.mjs';
import { queueEffectNow, sendHeldEffects } from '../../lib/effect-queue.mjs';
import { AUTO_CLOSE_MS, clockRules, cleanReading, judge, jobPin, cachedPin, jobIsToday, cleanSummary, cleanSignature, clockPayload, shiftView, pacificDay, PING_MIN_MS, TRAIL_MAX } from '../../lib/field-clock.mjs';

const asJson = v => typeof v === 'string' ? JSON.parse(v) : v;
const fail = e => { throw new StateError(e.message, e.status || 400); };
async function openShift(sql, workerKey) {
  const [row] = await sql`select * from field_shifts where worker_key = ${workerKey} and clock_out is null order by created_at desc limit 1`;
  return row || null;
}
async function state(sql, workerKey) {
  const open = await openShift(sql, workerKey);
  const today = await sql`select * from field_shifts where worker_key = ${workerKey} and created_at > now() - interval '36 hours' order by created_at desc limit 10`;
  return { open: shiftView(open), recent: today.map(shiftView), rules: clockRules(), day: pacificDay() };
}
// After the worker has their answer: if the job's address wasn't looked up yet, look it
// up now and fill in the punch's distance, then send the Make run (with the distance).
async function finishPunch(sql, action, row, pinKnown) {
  if (!pinKnown) {
    const pin = await jobPin(sql, row.job_id, row.job_address).catch(() => null);
    if (pin) {
      const field = action === 'clockOut' ? 'clock_out' : 'clock_in';
      const punch = asJson(row[field]), rules = clockRules();
      const fixed = { ...punch, ...judge({ lat: punch.lat, lng: punch.lng, acc: punch.acc }, pin, rules) };
      const trail = (asJson(row.trail) || []).map(p => p.at === punch.at ? { ...p, status: fixed.status, dist: fixed.dist } : p);
      const last = asJson(row.last_loc);
      const [updated] = action === 'clockOut'
        ? await sql`update field_shifts set clock_out = ${sql.json(fixed)}, trail = ${sql.json(trail)}, last_loc = ${sql.json(last?.at === punch.at ? fixed : last)}, updated_at = now() where id = ${row.id} returning *`
        : await sql`update field_shifts set clock_in = ${sql.json(fixed)}, trail = ${sql.json(trail)}, last_loc = ${sql.json(last?.at === punch.at ? fixed : last)}, updated_at = now() where id = ${row.id} returning *`;
      if (updated) row = updated;
    }
  }
  const shift = { ...row, clock_in: asJson(row.clock_in), clock_out: asJson(row.clock_out), summary: asJson(row.summary) };
  const effectId = await queueEffectNow(sql, { kind: 'clock', payload: clockPayload(action, shift), effectKey: `${row.id}-${action}` });
  return sendHeldEffects(sql, { ids: [effectId], timeoutMs: 15000 });
}
function sendClockRun(sql, action, row, context, pinKnown = true) {
  const run = finishPunch(sql, action, row, pinKnown).catch(error => console.error('Clock webhook not sent', action, row.id, error));
  if (context && typeof context.waitUntil === 'function') context.waitUntil(run);
  return run;
}

// Forgotten clock out: a shift open 16+ hours is closed when the worker next clocks in.
// The out time is the last location the phone sent (or the clock in, if none), marked
// autoClosed so payroll and the Time Clock flag it. Make gets a clockOut run as usual.
async function autoClose(sql, open, context) {
  const cin = asJson(open.clock_in), last = asJson(open.last_loc) || cin;
  const out = { ...last, at: last.at || cin.at, autoClosed: true };
  const summary = { work: '', notes: 'No clock out. Closed automatically at the next clock in; the out time is the last location the phone sent.', lang: 'en', at: new Date().toISOString(), auto: true };
  const [row] = await sql`update field_shifts set clock_out = ${sql.json(out)}, summary = ${sql.json(summary)}, updated_at = now() where id = ${open.id} and clock_out is null returning *`;
  if (row) sendClockRun(sql, 'clockOut', row, context);
  return !!row;
}

export default async function handler(request, context) {
  try {
    const identity = driverIdentityFromRequest(request);
    if (!identity) throw new StateError('Sign in again', 401);
    const workerKey = identity.driverKey;
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') return json(await state(sql, workerKey));
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await readPayload(request);
    const op = String(body.op || '');
    const rules = clockRules();

    if (op === 'ping') {
      const open = await openShift(sql, workerKey);
      if (!open) return json({ ok: true, open: null });
      let reading; try { reading = cleanReading(body.location, rules); } catch { return json({ ok: true, skipped: true }); }
      const last = asJson(open.last_loc);
      if (last?.at && Date.now() - Date.parse(last.at) < PING_MIN_MS) return json({ ok: true, skipped: true });
      const pin = await jobPin(sql, open.job_id, open.job_address);
      const at = new Date().toISOString();
      const loc = { at, ...judge(reading, pin, rules) };
      const trail = [...(asJson(open.trail) || []), { at, lat: loc.lat, lng: loc.lng, status: loc.status, dist: loc.dist }].slice(-TRAIL_MAX);
      await sql`update field_shifts set last_loc = ${sql.json(loc)}, trail = ${sql.json(trail)}, updated_at = now() where id = ${open.id} and clock_out is null`;
      return json({ ok: true, lastAt: at });
    }

    const requestId = String(body.requestId || '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw new StateError('A unique requestId is required', 428);

    if (op === 'clockIn') {
      const jobId = String(body.jobId || '').trim();
      if (!jobId) throw new StateError('Pick the job to clock in to');
      const shiftId = `shift-${requestId}`;
      const [already] = await sql`select * from field_shifts where id = ${shiftId}`;
      if (already) return json({ ok: true, replayed: true, ...(await state(sql, workerKey)) });
      const open = await openShift(sql, workerKey);
      if (open) {
        const forgotten = Date.now() - Date.parse(asJson(open.clock_in).at) >= AUTO_CLOSE_MS;
        if (!forgotten) throw new StateError(`You're still clocked in at ${open.job_address || 'another job'}. Clock out there first.`, 409);
      }
      const [row] = await sql`select * from job_shared_state where job_id = ${jobId}`;
      const job = row ? jobRecord(row) : null;
      if (!job || job.active === false || !matchesWorker(job, identity)) throw new StateError("You're not on this job's crew. Check with dispatch.", 403);
      if (!jobIsToday(job)) throw new StateError("This job isn't scheduled for today. Check with dispatch.", 409);
      let reading; try { reading = cleanReading(body.location, rules); } catch (e) { fail(e); }
      if (open) await autoClose(sql, open, context); // only reached for a forgotten one (checked above)
      const cached = await cachedPin(sql, jobId, job.jobAddress);
      const at = new Date().toISOString();
      const loc = { at, ...judge(reading, cached.pin, rules), requestId };
      const trail = [{ at, lat: loc.lat, lng: loc.lng, status: loc.status, dist: loc.dist }];
      const inserted = await sql`insert into field_shifts (id, worker_key, worker_name, worker_phone, job_id, job_address, client_name, job_scope, clock_in, last_loc, trail)
        values (${shiftId}, ${workerKey}, ${identity.name || ''}, ${identity.phone || ''}, ${jobId}, ${job.jobAddress || ''}, ${job.clientName || ''}, ${job.scopeOfWork || ''},
          ${sql.json(loc)}, ${sql.json(loc)}, ${sql.json(trail)})
        on conflict do nothing returning *`;
      if (!inserted.length) throw new StateError("You're already clocked in. Refresh the app.", 409); // a second phone or a double tap won the race
      sendClockRun(sql, 'clockIn', inserted[0], context, cached.known);
      return json({ ok: true, clockIn: { at, status: loc.status, dist: loc.dist }, ...(await state(sql, workerKey)) });
    }

    if (op === 'clockOut') {
      const [done] = await sql`select * from field_shifts where worker_key = ${workerKey} and clock_out->>'requestId' = ${requestId}`;
      if (done) return json({ ok: true, replayed: true, ...(await state(sql, workerKey)) });
      const open = await openShift(sql, workerKey);
      if (!open) throw new StateError("You're not clocked in. Refresh the app.", 409);
      let summary, reading, signature;
      try { summary = cleanSummary(body, body.lang); signature = cleanSignature(body.signature); reading = cleanReading(body.location, rules); } catch (e) { fail(e); }
      const cached = await cachedPin(sql, open.job_id, open.job_address);
      const at = new Date().toISOString();
      const loc = { at, ...judge(reading, cached.pin, rules), requestId };
      const trail = [...(asJson(open.trail) || []), { at, lat: loc.lat, lng: loc.lng, status: loc.status, dist: loc.dist }].slice(-TRAIL_MAX);
      const [row] = await sql`update field_shifts set clock_out = ${sql.json(loc)}, summary = ${sql.json({ ...summary, at })}, signature = ${signature}, last_loc = ${sql.json(loc)}, trail = ${sql.json(trail)}, updated_at = now()
        where id = ${open.id} and clock_out is null returning *`;
      if (!row) throw new StateError("You're not clocked in. Refresh the app.", 409);
      sendClockRun(sql, 'clockOut', row, context, cached.known);
      return json({ ok: true, clockOut: { at, status: loc.status, dist: loc.dist }, hoursWorked: clockPayload('clockOut', { ...row, clock_in: asJson(row.clock_in), clock_out: loc, summary: asJson(row.summary) }).hoursWorked, ...(await state(sql, workerKey)) });
    }
    throw new StateError('Unknown clock action');
  } catch (error) { return errorResponse(error); }
}
