// Completed job log for EOD Done > Completed job log.
//   POST /api/job-log   (Make, header x-make-secret = JOB_LOG_PUSH_SECRET)
//        body: one row, an array of rows, or { rows: [...] }. Optional
//        { replaceFrom, replaceTo } (YYYY-MM-DD) clears that range first, for a full resync.
//   GET  /api/job-log?from=YYYY-MM-DD&to=YYYY-MM-DD[&fresh=1]   (any signed-in user)
// GET reads the rows Make pushed. If JOB_LOG_READ_WEBHOOK is set instead, it asks
// Make for the range on demand ({ action: "read", from, to }). See MAKE-SETUP.md.
import { db, ensureSchema } from './db.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { requireSession, secretMatches } from '../../lib/session.mjs';
import { StateError } from '../../lib/state.mjs';
import { normalizeJobLog, pushedRows, jobLogRowKey } from '../../lib/job-log.mjs';
const cache = new Map();
const CACHE_MS = 60 * 1000;
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
async function receive(request) {
  const expected = process.env.JOB_LOG_PUSH_SECRET || '';
  if (!expected) return json({ ok: false, error: 'Set JOB_LOG_PUSH_SECRET in Netlify first.' }, 503);
  if (!secretMatches(request.headers.get('x-make-secret') || '', expected)) return json({ ok: false, error: 'Wrong x-make-secret' }, 401);
  const text = await request.text();
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) return json({ ok: false, error: 'Too much at once. Send 4 MB or less per call.' }, 413);
  let body; try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'Body must be JSON (Body content type: JSON, or custom application/json).' }, 400); }
  let rows; try { rows = pushedRows(body); } catch (error) { return json({ ok: false, error: error.message }, 400); }
  const replaceFrom = body?.replaceFrom, replaceTo = body?.replaceTo || replaceFrom;
  if (replaceFrom && (!isDay(replaceFrom) || !isDay(replaceTo))) return json({ ok: false, error: 'replaceFrom and replaceTo must be YYYY-MM-DD' }, 400);
  const sql = db(); await ensureSchema(sql);
  let skipped = 0;
  await sql.begin(async tx => {
    if (replaceFrom) await tx`delete from dispatch_job_log where day between ${replaceFrom} and ${replaceTo}`;
    for (const row of rows) {
      if (!row.date) { skipped++; continue; }
      await tx`insert into dispatch_job_log (row_key, day, data) values (${jobLogRowKey(row)}, ${row.date}, ${tx.json(row)})
        on conflict (row_key) do update set day = excluded.day, data = excluded.data, updated_at = now()`;
    }
  });
  cache.clear();
  return json({ ok: true, saved: rows.length - skipped, skipped, ...(skipped ? { note: 'Rows with no date were skipped (send date or reportDate).' } : {}) });
}
async function readPushed(from, to) {
  const sql = db(); await ensureSchema(sql);
  const rows = await sql`select data from dispatch_job_log where day between ${from} and ${to} order by day desc, updated_at desc limit 3000`;
  return rows.map(r => typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
}
async function readFromMake(hook, from, to) {
  let response;
  try {
    response = await fetch(hook, {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { 'Content-Type': 'application/json', ...(process.env.MAKE_API_KEY ? { 'x-make-apikey': process.env.MAKE_API_KEY } : {}) },
      body: JSON.stringify({ action: 'read', from, to })
    });
  } catch (error) { console.error('Job log read failed', error); throw new StateError('Make did not answer in time. Try Refresh.', 502); }
  if (!response.ok) throw new StateError(`Make answered HTTP ${response.status}. Check the job log read scenario.`, 502);
  try { return normalizeJobLog(await response.json(), from, to); }
  catch (error) { console.error('Job log read bad body', error); throw new StateError('Make answered, but not with JSON rows. End the scenario with a Webhook response (body = the rows array).', 502); }
}
export default async function handler(request) {
  try {
    if (request.method === 'POST') return await receive(request);
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    await requireSession(request);
    const url = new URL(request.url);
    const from = url.searchParams.get('from'), to = url.searchParams.get('to') || from;
    if (!isDay(from) || !isDay(to) || from > to) throw new StateError('Pick a valid day or range.');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw new StateError('Pick a range of 3 months or less.');
    const hook = process.env.JOB_LOG_READ_WEBHOOK;
    if (!hook && !process.env.JOB_LOG_PUSH_SECRET) return json({ ok: false, notSetUp: true, rows: [], error: 'The job log is not connected yet. Add JOB_LOG_PUSH_SECRET in Netlify and have Make send rows to /api/job-log (see MAKE-SETUP.md).' }, 503);
    if (!hook) return json({ ok: true, from, to, rows: await readPushed(from, to) });
    const cacheKey = `${from}|${to}`;
    const hit = cache.get(cacheKey);
    if (hit && url.searchParams.get('fresh') !== '1' && Date.now() - hit.at < CACHE_MS) return json({ ok: true, from, to, rows: hit.rows, cached: true });
    let rows;
    try { rows = await readFromMake(hook, from, to); }
    catch (error) { return json({ ok: false, rows: [], error: error.message }, error.status || 502); }
    cache.set(cacheKey, { at: Date.now(), rows });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    return json({ ok: true, from, to, rows });
  } catch (error) { return errorResponse(error); }
}
