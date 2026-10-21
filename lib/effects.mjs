// Make workflow webhooks (non-state side effects) and the one place that posts to them.
// Used by /api/workflow-effect and by the senior admin Retry button.
import { eodWorkbookAttachment, eodMultipart, eodFileName } from './eod-xlsx.mjs';
// Existing workflows retained. Only non-state effects belong in these scenarios.
export const workflows = {
  project_schedule: ['PROJECT_SCHEDULE_WEBHOOK', 'https://hook.us2.make.com/ym8j30bvydhops1cbq53y4yjypzx7z8k'],
  workers: ['WORKER_EFFECT_WEBHOOK', 'https://hook.us2.make.com/dk8dm3t7opzdpmemah0gor2wiq3swq5l'],
  drivers: ['DRIVER_EFFECT_WEBHOOK', 'https://hook.us2.make.com/y7ko2j9343i7mvy1zzweq6db25f31t8k'],
  job_details: ['JOB_DETAILS_WEBHOOK', 'https://hook.us2.make.com/urj9p6bifsl1m9s72y8sq02zn2gydv59'],
  job_stage: ['JOB_ACTION_WEBHOOK', 'https://hook.us2.make.com/s2ijm77vf023z47b1dncn4jm9yt11w1d'],
  container: ['BOOK_CONTAINER_WEBHOOK', 'https://hook.us2.make.com/30np7d1bieaapqcluxlkxdgbg8l5pw2w'],
  driver_log: ['DRIVER_LOG_WEBHOOK', 'https://hook.us2.make.com/tp2wwcdltmjyi1gsrc9mhywksiygqouo'],
  // Complete EOD Sheet: same webhook the job Reset Day already posts to (workers),
  // routed in Make on action "eod_sheet". Follows WORKER_EFFECT_WEBHOOK if that is set.
  eod_sheet: ['EOD_SHEET_WEBHOOK', 'https://hook.us2.make.com/dk8dm3t7opzdpmemah0gor2wiq3swq5l'],
  // Job log: fired alongside eod_sheet on Complete EOD Sheet (plain JSON, no file).
  job_log: ['JOB_LOG_WEBHOOK', 'https://hook.us2.make.com/vqurtuiuxdbg9k1j7v03prsffquvh1xa'],
  // Worker sent home: dispatch picks the hours worked; the worker is released from the job.
  worker_sent_home: ['WORKER_SENT_HOME_WEBHOOK', 'https://hook.us2.make.com/mo2wtttzdfhpl4liym6c8uw3pbq6mmth'],
  // Split day booking: a worker already booked on another job is added to this one
  // (Split day · Include booked). Only that worker's notification goes here; everyone
  // else in the same assignment still goes to the normal workers webhook.
  split_day: ['SPLIT_DAY_WEBHOOK', 'https://hook.us2.make.com/pnoqc8i87kix7qiyjkmfek9axgvjh4z6'],
  // Job hours: one run per worker on Complete EOD Sheet, for the A2Z Weekly Hours
  // sheets (date, employeeName, hoursWorked, notes). Plain JSON, no file.
  job_hours: ['JOB_HOURS_WEBHOOK', 'https://hook.us2.make.com/swmlb2j1ef0k89fesawlizhmur714kqo'],
  // Laborer added: Admin > Workers > + Add from GHL. One plain JSON run per add.
  labor_added: ['LABOR_ADDED_WEBHOOK', 'https://hook.us2.make.com/wk9leiggp4mlr2g5n1acq862y6my52ia'],
  // Afternoon Logistics reminder: tomorrow's moves still missing a time, driver or vehicle.
  logistics_reminder: ['LOGISTICS_REMINDER_WEBHOOK', 'https://hook.us2.make.com/cw5dsqfr8qsr5vb9hr1rehspyl6pa3v2'],
  // Same reminder for the labor side: tomorrow's jobs with no crew, a short crew or no time.
  // Same webhook and the same payload fields as logistics_reminder; action "labor_reminder".
  labor_reminder: ['LABOR_REMINDER_WEBHOOK', 'https://hook.us2.make.com/cw5dsqfr8qsr5vb9hr1rehspyl6pa3v2']
};
export const webhookUrl = kind => {
  const [env, fallback] = workflows[kind];
  return process.env[env] || (kind === 'eod_sheet' && process.env.WORKER_EFFECT_WEBHOOK) || fallback;
};

function jobWeekFields(date) {
  const d = new Date(String(date || '') + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return { weekStart: '', weekEnd: '', weekRange: '' };
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const format = value => `${String(value.getUTCMonth() + 1).padStart(2, '0')}/${String(value.getUTCDate()).padStart(2, '0')}`;
  const weekStart = format(d);
  d.setUTCDate(d.getUTCDate() + 6);
  const weekEnd = format(d);
  return { weekStart, weekEnd, weekRange: `${weekStart}-${weekEnd}` };
}

// Throws if Make doesn't answer {"ok":true}.
export async function sendWorkflow(kind, payload, effectId, { timeoutMs } = {}) {
  if (kind === 'project_schedule') {
    try {
      const { sendProjectSchedule } = await import('./project-schedule.mjs');
      return await sendProjectSchedule(payload, { url: webhookUrl(kind), eventId: effectId });
    } catch (error) {
      throw new Error(`Webhook ${kind} (${webhookUrl(kind)}): ${error.message || error}`, { cause: error });
    }
  }
  if (['job_log', 'eod_sheet', 'job_hours', 'driver_log'].includes(kind)) {
    const date = payload.date || payload.reportDate;
    const d = new Date(String(date || '') + 'T12:00:00Z');
    payload = { ...payload, ...jobWeekFields(date), dayOfWeek: Number.isNaN(d.getTime()) ? String(payload.dayOfWeek || '').toLowerCase() : d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toLowerCase() };
  }
  // EOD sheet: multipart/form-data with the filled Job Costing workbook as
  // binary "file" (same as the Project Schedule PDF). EOD_SHEET_FORMAT=json
  // restores the old JSON body with base64 file.data.
  const makeHeaders = process.env.MAKE_API_KEY ? { 'x-make-apikey': process.env.MAKE_API_KEY } : {};
  const eodJson = process.env.EOD_SHEET_FORMAT === 'json';
  const body = kind === 'eod_sheet' && !eodJson
    ? eodMultipart(payload, effectId)
    : JSON.stringify({ ...payload, ...(kind === 'eod_sheet' ? { file: eodWorkbookAttachment(payload) } : {}), eventId: effectId });
  try {
  const response = await fetch(webhookUrl(kind), {
    // Give Make up to 45 s to finish the scenario and answer before it counts as a problem.
    method: 'POST', signal: AbortSignal.timeout(timeoutMs || Math.max(10000, Number(process.env.MAKE_TIMEOUT_MS) || 45000)),
    headers: typeof body === 'string' ? { 'content-type': 'application/json', ...makeHeaders } : makeHeaders,
    body
  });
  const text = await response.text();
  let result = {};
  try { result = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(`Make refused the run (HTTP ${response.status})`);
  if (/^\s*accepted\s*$/i.test(text)) throw new Error('Make answered "Accepted" instead of {"ok":true}: this route has no Webhook response at the end, or the scenario is not set to run immediately.');
  if (result.ok !== true) throw new Error(`Make did not answer {"ok":true}${text ? ': ' + text.slice(0, 120) : ''}`);
  return { fileName: kind === 'eod_sheet' ? eodFileName(payload) : '' };
  } catch (error) {
    throw new Error(`Webhook ${kind} (${webhookUrl(kind)}): ${error.message || error}`, { cause: error });
  }
}
