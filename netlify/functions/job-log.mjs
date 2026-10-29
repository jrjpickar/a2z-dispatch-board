import { randomUUID } from 'node:crypto';
// Completed job log for EOD Done > Completed job log.
//   POST /api/job-log   (Make, header x-make-secret = JOB_LOG_PUSH_SECRET)
//        body: one row, an array of rows, or { rows: [...] }. Optional
//        { replaceFrom, replaceTo } (YYYY-MM-DD) clears that range first, for a full resync.
//   POST /api/job-log?pdf=1&eventId=...  or  ?pdf=1&jobId=...&date=YYYY-MM-DD[&action=eod_sheet]
//        (Make, same secret) body = the PDF (raw application/pdf, or multipart field "file").
//        Attaches a PDF to that job log row; sending again replaces it.
//   GET  /api/job-log?from=YYYY-MM-DD&to=YYYY-MM-DD[&fresh=1]   (any signed-in user)
//   GET  /api/job-log?pdf=<id>                                   (any signed-in user) opens the PDF
// GET reads the rows Make pushed. If JOB_LOG_READ_WEBHOOK is set instead, it asks
// Make for the range on demand ({ action: "read", from, to }). See MAKE-SETUP.md.
import { db, ensureSchema } from './db.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { requireSession, secretMatches } from '../../lib/session.mjs';
import { StateError } from '../../lib/state.mjs';
import { normalizeJobLog, pushedRows, jobLogRowKey, pdfMatchKey, attachPdfs, toIsoDay } from '../../lib/job-log.mjs';
const cache = new Map();
const CACHE_MS = 60 * 1000;
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
function makeAuthError(request) {
  const expected = process.env.JOB_LOG_PUSH_SECRET || '';
  if (!expected) return json({ ok: false, error: 'Set JOB_LOG_PUSH_SECRET in Netlify first.' }, 503);
  if (!secretMatches(request.headers.get('x-make-secret') || '', expected)) return json({ ok: false, error: 'Wrong x-make-secret' }, 401);
  return null;
}
const MAX_PDF = 5 * 1024 * 1024;
async function receivePdf(request, url) {
  const p = url.searchParams;
  const eventId = (p.get('eventId') || p.get('rowId') || '').trim(), jobId = (p.get('jobId') || '').trim();
  const date = toIsoDay(p.get('date') || p.get('reportDate') || ''), action = /complete/i.test(p.get('action') || '') ? 'complete' : 'eod_sheet';
  if (!eventId && !(jobId && date)) return json({ ok: false, error: 'Add eventId, or jobId and date, to the URL.' }, 400);
  if (Number(request.headers.get('content-length')) > MAX_PDF) return json({ ok: false, error: 'PDF must be 5 MB or smaller.' }, 413);
  let bytes, name = (p.get('name') || '').trim();
  if ((request.headers.get('content-type') || '').toLowerCase().includes('multipart/form-data')) {
    const file = (await request.formData()).get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return json({ ok: false, error: 'Multipart body needs a "file" field.' }, 400);
    bytes = Buffer.from(await file.arrayBuffer()); name ||= file.name || '';
  } else bytes = Buffer.from(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_PDF) return json({ ok: false, error: 'PDF must be nonempty and 5 MB or smaller.' }, 413);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return json({ ok: false, error: 'That body is not a PDF. Send the file data itself (for example {{21.data}}), not a link or text.' }, 400);
  name = (name || `${jobId || eventId} ${date || ''} EOD.pdf`.replace(/\s+/g, ' ').trim()).replace(/[\r\n"]/g, '').slice(0, 200);
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  const key = pdfMatchKey({ eventId, jobId, action, date });
  const sql = db(); await ensureSchema(sql);
  const [saved] = await sql`insert into dispatch_job_log_pdf (id, match_key, job_id, action, day, event_id, name, content_base64)
    values (${randomUUID()}, ${key}, ${jobId}, ${action}, ${date}, ${eventId}, ${name}, ${bytes.toString('base64')})
    on conflict (match_key) do update set name = excluded.name, content_base64 = excluded.content_base64, job_id = excluded.job_id, day = excluded.day, updated_at = now()
    returning id`;
  return json({ ok: true, pdfId: saved.id, attachedTo: key });
}
async function servePdf(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new StateError('PDF not found', 404);
  const sql = db(); await ensureSchema(sql);
  const [doc] = await sql`select name, content_base64 from dispatch_job_log_pdf where id = ${id}`;
  if (!doc) throw new StateError('PDF not found', 404);
  return new Response(Buffer.from(doc.content_base64, 'base64'), { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } });
}
async function withPdfs(rows, from, to) {
  if (!rows.length) return rows;
  const sql = db(); await ensureSchema(sql);
  const ids = [...new Set(rows.map(r => r.rowId).filter(Boolean).map(id => `event:${id}`))];
  const pdfs = await sql`select id, match_key from dispatch_job_log_pdf where (day between ${from} and ${to}) or match_key = any(${ids})`;
  return attachPdfs(rows, pdfs);
}
async function receive(request) {
  const denied = makeAuthError(request); if (denied) return denied;
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
    const url = new URL(request.url);
    if (request.method === 'POST' && url.searchParams.get('pdf') != null) { const denied = makeAuthError(request); return denied || await receivePdf(request, url); }
    if (request.method === 'POST') return await receive(request);
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    await requireSession(request);
    if (url.searchParams.get('pdf')) return await servePdf(url.searchParams.get('pdf'));
    const from = url.searchParams.get('from'), to = url.searchParams.get('to') || from;
    if (!isDay(from) || !isDay(to) || from > to) throw new StateError('Pick a valid day or range.');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw new StateError('Pick a range of 3 months or less.');
    const hook = process.env.JOB_LOG_READ_WEBHOOK;
    if (!hook && !process.env.JOB_LOG_PUSH_SECRET) return json({ ok: false, notSetUp: true, rows: [], error: 'The job log is not connected yet. Add JOB_LOG_PUSH_SECRET in Netlify and have Make send rows to /api/job-log (see MAKE-SETUP.md).' }, 503);
    if (!hook) return json({ ok: true, from, to, rows: await withPdfs(await readPushed(from, to), from, to) });
    const cacheKey = `${from}|${to}`;
    const hit = cache.get(cacheKey);
    if (hit && url.searchParams.get('fresh') !== '1' && Date.now() - hit.at < CACHE_MS) return json({ ok: true, from, to, rows: hit.rows, cached: true });
    let rows;
    try { rows = await readFromMake(hook, from, to); }
    catch (error) { return json({ ok: false, rows: [], error: error.message }, error.status || 502); }
    try { rows = await withPdfs(rows, from, to); } catch (error) { console.error('Job log PDFs lookup failed', error); }
    cache.set(cacheKey, { at: Date.now(), rows });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    return json({ ok: true, from, to, rows });
  } catch (error) { return errorResponse(error); }
}
