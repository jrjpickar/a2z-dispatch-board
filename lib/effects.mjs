// Make workflow webhooks (non-state side effects) and the one place that posts to them.
// Used by /api/workflow-effect and by the senior admin Retry button.
import { eodWorkbookAttachment, eodMultipart, eodFileName } from './eod-xlsx.mjs';
// Existing workflows retained. Only non-state effects belong in these scenarios.
export const workflows = {
  workers: ['WORKER_EFFECT_WEBHOOK', 'https://hook.us2.make.com/dk8dm3t7opzdpmemah0gor2wiq3swq5l'],
  drivers: ['DRIVER_EFFECT_WEBHOOK', 'https://hook.us2.make.com/y7ko2j9343i7mvy1zzweq6db25f31t8k'],
  job_details: ['JOB_DETAILS_WEBHOOK', 'https://hook.us2.make.com/urj9p6bifsl1m9s72y8sq02zn2gydv59'],
  job_stage: ['JOB_ACTION_WEBHOOK', 'https://hook.us2.make.com/s2ijm77vf023z47b1dncn4jm9yt11w1d'],
  container: ['BOOK_CONTAINER_WEBHOOK', 'https://hook.us2.make.com/30np7d1bieaapqcluxlkxdgbg8l5pw2w'],
  driver_log: ['DRIVER_LOG_WEBHOOK', 'https://hook.us2.make.com/tp2wwcdltmjyi1gsrc9mhywksiygqouo'],
  // Complete EOD Sheet: same webhook the job Reset Day already posts to (workers),
  // routed in Make on action "eod_sheet". Follows WORKER_EFFECT_WEBHOOK if that is set.
  eod_sheet: ['EOD_SHEET_WEBHOOK', 'https://hook.us2.make.com/dk8dm3t7opzdpmemah0gor2wiq3swq5l']
};
export const webhookUrl = kind => {
  const [env, fallback] = workflows[kind];
  return process.env[env] || (kind === 'eod_sheet' && process.env.WORKER_EFFECT_WEBHOOK) || fallback;
};

// Throws if Make doesn't answer {"ok":true}.
export async function sendWorkflow(kind, payload, effectId) {
  // EOD sheet: multipart/form-data with the filled Job Costing workbook as
  // binary "file" (same as the Project Schedule PDF). EOD_SHEET_FORMAT=json
  // restores the old JSON body with base64 file.data.
  const makeHeaders = process.env.MAKE_API_KEY ? { 'x-make-apikey': process.env.MAKE_API_KEY } : {};
  const eodJson = process.env.EOD_SHEET_FORMAT === 'json';
  const body = kind === 'eod_sheet' && !eodJson
    ? eodMultipart(payload, effectId)
    : JSON.stringify({ ...payload, ...(kind === 'eod_sheet' ? { file: eodWorkbookAttachment(payload) } : {}), eventId: effectId });
  const response = await fetch(webhookUrl(kind), {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: typeof body === 'string' ? { 'content-type': 'application/json', ...makeHeaders } : makeHeaders,
    body
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok || result.ok !== true) throw new Error(`Make did not confirm completion (HTTP ${response.status})`);
  return { fileName: kind === 'eod_sheet' ? eodFileName(payload) : '' };
}
