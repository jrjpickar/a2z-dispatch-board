// Dispatch board > Jobs Scheduled > Time Clock (read only).
//   GET /api/time-clock?day=YYYY-MM-DD        (signed-in board user)
//   GET /api/time-clock?signature=<shiftId>   the clock out signature (PNG)
// Every field app shift clocked in on that Pacific day, plus anyone still on the
// clock from an earlier day, with their clock in / live / clock out locations,
// the location trail for the map, the work summary, and each job's map pin.
import { db, ensureSchema } from './db.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { requireSession } from '../../lib/session.mjs';
import { StateError } from '../../lib/state.mjs';
import { clockRules, pacificDay } from '../../lib/field-clock.mjs';

const asJson = v => typeof v === 'string' ? JSON.parse(v) : v;
const loc = p => p ? { at: p.at, lat: p.lat, lng: p.lng, acc: p.acc ?? null, dist: p.dist ?? null, status: p.status || 'unknown', auto: !!p.autoClosed } : null;
const dayShift = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    await requireSession(request);
    const url = new URL(request.url);
    const sigId = url.searchParams.get('signature');
    if (sigId) {
      const sql = db(); await ensureSchema(sql);
      const [row] = await sql`select signature from field_shifts where id = ${String(sigId).slice(0, 200)}`;
      if (!row?.signature) throw new StateError('No signature on that shift', 404);
      return new Response(Buffer.from(row.signature, 'base64'), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } });
    }
    const day = url.searchParams.get('day') || pacificDay();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new StateError('day must be YYYY-MM-DD');
    const sql = db(); await ensureSchema(sql);
    // A day either side covers the Pacific offset; the exact day is checked below.
    const rows = await sql`select * from field_shifts
      where (created_at >= ${dayShift(day, -1) + 'T00:00:00Z'} and created_at < ${dayShift(day, 2) + 'T00:00:00Z'}) or clock_out is null
      order by created_at`;
    const today = pacificDay();
    const shifts = rows.map(r => ({ ...r, clock_in: asJson(r.clock_in), clock_out: asJson(r.clock_out), last_loc: asJson(r.last_loc), trail: asJson(r.trail) || [], summary: asJson(r.summary) }))
      .filter(r => pacificDay(r.clock_in.at) === day || (!r.clock_out && day === today))
      .map(r => ({
        id: r.id, jobId: r.job_id, jobAddress: r.job_address, clientName: r.client_name,
        workerName: r.worker_name, workerPhone: r.worker_phone,
        clockIn: loc(r.clock_in), clockOut: loc(r.clock_out), last: loc(r.last_loc || r.clock_in),
        trail: r.trail.filter(p => Number.isFinite(p.lat)).map(p => ({ at: p.at, lat: p.lat, lng: p.lng, status: p.status })),
        summary: r.summary ? { work: r.summary.work || '', notes: r.summary.notes || '', lang: r.summary.lang || '',
          breaksCertified: typeof r.summary.breaksCertified === 'boolean' ? r.summary.breaksCertified : null, breaksNote: r.summary.breaksNote || '',
          locationConsent: r.summary.locationConsent === true, signedAt: r.signature ? r.summary.at || '' : '', hasSignature: !!r.signature, auto: !!r.summary.auto } : null
      }));
    const jobIds = [...new Set(shifts.map(s => s.jobId))];
    const pins = jobIds.length ? await sql`select job_id, lat, lng from job_geocode where job_id = any(${jobIds}) and lat is not null` : [];
    return json({ day, today, rules: clockRules(), pingMinutes: 5, shifts, pins: Object.fromEntries(pins.map(p => [p.job_id, { lat: Number(p.lat), lng: Number(p.lng) }])) });
  } catch (error) { return errorResponse(error); }
}
