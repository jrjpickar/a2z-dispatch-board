import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse, authorizeRead } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { waitsForHold, isRapid, claimRapid, syncJob, waitingSummary, ensureHoldTables, holdSchedule, notifiedOnJob, resendTimes, owedTexts, recordDontText, jobState, textPlan, textJob, logScheduleWorkers, sendJobScheduleNow, textWorkerNow } from '../../lib/daily-dispatch.mjs';
import { sessionFromRequest } from '../../lib/session.mjs';
import { logActivity } from '../../lib/activity.mjs';
import { refreshTimer, startRunner } from '../../lib/hold-timer.mjs';
import { recordEffect, deliverEffect, sendHeldEffects, cancelHeldEffects, startHeldSend, QUIET_STATUSES } from '../../lib/effect-queue.mjs';
// Safety net while boards are open (the database is awake then anyway): a held crew run
// more than 2 minutes past due means the timer missed it, so start the runner.
let lastOverdueCheck = 0;
async function overdueCheck(sql) {
  if (Date.now() - lastOverdueCheck < 5 * 60e3) return;
  lastOverdueCheck = Date.now();
  const late = (await holdSchedule(sql)).map(j => j.dueAt).filter(d => d != null && d < Date.now() - 120e3);
  if (late.length) await startRunner(Math.min(...late));
  else if ((await owedTexts(sql)).length) await refreshTimer(sql); // a text cut off after its Make run
}
const idList = value => (Array.isArray(value) ? value : []).map(v => String(v || '').slice(0, 240)).filter(Boolean).slice(0, 20);
export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST') await authorizeWrite(request);
    else await authorizeRead(request);
    const sql = db(); await ensureSchema(sql); await ensureHoldTables(sql);
    if (request.method === 'GET') {
      // ?waiting=jobs: crew changes waiting for their 12 hour mark, per job (Send now box).
      if (new URL(request.url).searchParams.get('waiting') === 'jobs') return json(await waitingSummary(sql));
      // ?notified=<jobId>: workers already sent this job and still on it (new times prompt).
      const notifiedJob = new URL(request.url).searchParams.get('notified');
      if (notifiedJob) return json({ workers: await notifiedOnJob(sql, notifiedJob.slice(0, 160)) });
      // Every open board polls this, so it also sends anything whose undo window is over.
      try { await sendHeldEffects(sql); } catch (error) { console.error('Held send sweep failed', error); }
      try { await overdueCheck(sql); } catch (error) { console.error('Crew hold check failed', error); }
      return json({ issues: await sql`select effect_id as id, kind, status, last_error as error from dispatch_effects where not (status = any(${QUIET_STATUSES})) order by created_at desc limit 50` });
    }
    const body = await readPayload(request);
    // Send now (job row): sends this job as it sits right now, without waiting for its
    // 12 hour mark: waiting Make assign / remove runs (only what still stands, once per
    // worker) and the schedule text to anyone notified who hasn't gotten it.
    if (body.op === 'job_send_now') {
      const jobId = String(body.jobId || '').slice(0, 160);
      if (!jobId) throw new StateError('Pick the job to send');
      const result = await sendJobScheduleNow(sql, jobId);
      const state = await jobState(sql, jobId);
      if (state && !result.skipped) await logScheduleWorkers(sql, sessionFromRequest(request), 'Sent schedule now', { ...state, jobId }, state.crew || [], { force: true, workerSkips: result.workerSkips });
      await refreshTimer(sql);
      const ok = !result.makeFailed && result.textOk && !result.skipped;
      const error = result.skipped === 'closed' ? 'This job is closed.' : result.skipped === 'no_date' ? 'This job has no date, so nothing can go out. Save its times, then Send now.' : 'Some of it did not finish. Check Admin > Make / GHL problems.';
      return json({ ok, ...result, ...(ok ? {} : { error }) });
    }
    // Text crew (job row dropdown): one worker, held 5 seconds and confirmed on the board.
    if (body.op === 'worker_text_now') {
      const jobId = String(body.jobId || '').slice(0, 160);
      if (!jobId) throw new StateError('Pick the job');
      const w = body.worker && typeof body.worker === 'object' ? body.worker : {};
      const worker = { contactId: String(w.contactId || '').slice(0, 120), workerName: String(w.workerName || '').slice(0, 120), workerPhone: String(w.workerPhone || '').slice(0, 40) };
      if (!worker.contactId && !worker.workerName && !worker.workerPhone) throw new StateError('Pick the worker to text');
      const result = await textWorkerNow(sql, jobId, worker);
      await logScheduleWorkers(sql, sessionFromRequest(request), 'Sent schedule text', { ...result.state, jobId }, [{ ...result.worker, dontText: false }], { force: true });
      const name = result.worker.name || worker.workerName;
      const error = !result.makeOk && !result.textOk ? `Neither the Make run nor the text for ${name} was confirmed.`
        : !result.makeOk ? `${name} was texted, but the Make run (worker webhook) was not confirmed.` : `The Make run went out, but the text to ${name} was not confirmed.`;
      return json({ ok: result.ok, makeOk: result.makeOk, textOk: result.textOk, makeAction: result.makeAction, worker: name, date: result.date,
        ...(result.ok ? {} : { error: error + ' Check Admin > Make / GHL problems and retry there.' }) });
    }
    // New times saved after the crew was sent the job: dispatch picked Text the new times
    // (resend true) or Don't text (logged only).
    if (body.op === 'times_changed') {
      const jobId = String(body.jobId || '').slice(0, 160);
      if (!jobId) throw new StateError('Pick the job');
      const session = sessionFromRequest(request);
      const prev = body.previous && typeof body.previous === 'object' ? body.previous : {};
      const was = [prev.reportDate, prev.reportTime].filter(Boolean).join(' ');
      if (body.resend !== true) {
        // Moved to another day and dispatch said Don't text: recorded, so the timer does not
        // send the new day to them on its own (it does for crew carried to a new day otherwise).
        const workers = await notifiedOnJob(sql, jobId);
        const [row] = await sql`select data from job_shared_state where job_id = ${jobId}`;
        const date = String((typeof row?.data === 'string' ? JSON.parse(row.data) : (row?.data || {})).reportDate || '');
        if (workers.length && date && date !== String(prev.reportDate || '')) await recordDontText(sql, { jobId, reportDate: date, workers, by: session?.name || '' });
        await logActivity(sql, session, 'Changed job times, crew not texted', String(body.jobAddress || jobId).slice(0, 200), { jobId, previous: prev });
        return json({ ok: true, texted: 0 });
      }
      const result = await resendTimes(sql, jobId, { previous: prev, by: session?.name || '' });
      if (!result.duplicate) await logActivity(sql, session, 'Texted crew new job times', String(body.jobAddress || jobId).slice(0, 200), { jobId, previous: prev, was, makeSent: result.makeSent, texted: result.texted });
      return json(result.ok ? result : { ...result, error: result.skipped ? 'This job is closed.' : 'Some of it did not finish. Check Admin > Make / GHL problems.' });
    }
    // "Don't text workers": recorded only, so the text tracker shows it as Don't text, not missed.
    if (body.op === 'dont_text') {
      const session = sessionFromRequest(request);
      const n = await recordDontText(sql, { jobId: String(body.jobId || '').slice(0, 160), reportDate: String(body.reportDate || ''), workers: body.workers, by: session?.name || '' });
      return json({ ok: true, recorded: n });
    }
    // Undo window controls for held sends.
    if (body.op === 'cancel') {
      const ids = idList(body.effectIds); if (!ids.length) throw new StateError('Nothing to undo');
      const result = await cancelHeldEffects(sql, ids);
      return json({ ok: result.tooLate.length === 0, ...result });
    }
    if (body.op === 'send') {
      const ids = idList(body.effectIds); if (!ids.length) throw new StateError('Nothing to send');
      const result = await sendHeldEffects(sql, { ids });
      return json({ ok: result.failed.length === 0, ...result });
    }
    const { requestId, kind, payload, effectKey, delayMs } = body;
    // Crew schedule text from Assign selected: nothing to queue. The server texts the crew
    // at the job's 12 hour mark. Send schedule now (rapidAssign) texts right away, below.
    if (kind === 'crew_text' && payload?.rapidAssign !== true) return json({ ok: true, held: true });
    // Assign / remove / split day: held until 12 hours before the job (lib/daily-dispatch.mjs).
    // Inside the 12 hours it all goes now; a remove goes now only to a worker already notified.
    if (waitsForHold(kind, payload)) {
      let sendAt = null;
      if (payload.textAtMode) {
        const state = await jobState(sql, payload.jobId);
        const plan = textPlan(state, payload);
        sendAt = plan.textAt || null;
      }
      const { effectId, status } = await recordEffect(sql, { requestId, kind, payload, effectKey, nightly: true, sendAt });
      if (status !== 'new') return json({ ok: true, replayed: true, effectId, status });
      const [job] = (await holdSchedule(sql)).filter(j => j.jobId === String(payload.jobId));
      const due = !!job && job.dueAt != null && job.dueAt <= Date.now();
      const result = await syncJob(sql, payload.jobId, { mode: due ? 'due' : 'removes', why: due ? 'inside_12h' : 'remove' });
      await refreshTimer(sql);
      const [still] = await sql`select status from dispatch_effects where effect_id = ${effectId}`;
      const held = still?.status === 'nightly';
      const planned = job?.rows.find(row => row.effect_id === effectId)?.dueAt;
      if (result.makeFailed) return json({ error: 'Dispatch saved; Make did not confirm. Check Admin > Make / GHL problems.', held, effectId }, 502);
      return json({ ok: true, held, effectId, status: still?.status || '', dueAt: held && planned != null ? new Date(planned).toISOString() : '', makeSent: result.makeSent, texted: result.texted });
    }
    // Send schedule now (rapid): right away, but never twice to the same worker for the same job and day.
    if (isRapid(kind, payload)) {
      const { effectId, status } = await recordEffect(sql, { requestId, kind, payload, effectKey });
      if (status === 'confirmed' || status === 'cancelled') return json({ ok: true, replayed: true });
      if (status !== 'new') return json({ error: 'Workflow was already attempted. Check Make history before rerunning to avoid duplicate notifications.', status }, 409);
      if (await claimRapid(sql, { effectId, kind, payload }) === 'duplicate') return json({ ok: true, duplicate: true });
      const ok = await deliverEffect(sql, { effect_id: effectId, kind, payload });
      if (kind === 'split_day' && payload.jobId2 && ok) await textJob(sql, payload.jobId2, 'rapid_assign');
      await refreshTimer(sql);
      return ok ? json({ ok: true }) : json({ error: 'Dispatch saved; workflow completion is unconfirmed. Check Make execution history.' }, 502);
    }
    const { effectId, status } = await recordEffect(sql, { requestId, kind, payload, effectKey, delayMs });
    if (delayMs > 0) {
      if (status === 'new') await startHeldSend(effectId); // server timer: sends at due_at even if every board closes
      if (status === 'new' || status === 'scheduled') return json({ ok: true, scheduled: true, effectId });
      return json({ ok: status !== 'cancelled', effectId, status });
    }
    if (status === 'confirmed') return json({ ok: true, replayed: true });
    if (status !== 'new') return json({ error: 'Workflow was already attempted. Check Make history before rerunning to avoid duplicate notifications.', status }, 409);
    const ok = await deliverEffect(sql, { effect_id: effectId, kind, payload });
    return ok ? json({ ok: true }) : json({ error: 'Dispatch saved; workflow completion is unconfirmed. Check Make execution history.' }, 502);
  } catch (error) { return errorResponse(error); }
}
