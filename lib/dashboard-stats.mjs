// Numbers behind the Admin page charts. Dates are the board's local dates
// (America/Los_Angeles unless BOARD_TIME_ZONE is set).
const TZ = () => process.env.BOARD_TIME_ZONE || 'America/Los_Angeles';
const DAY = 86400000;
export const localToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const toMs = d => Date.parse(d + 'T00:00:00Z');
const fromMs = ms => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d, n) => fromMs(toMs(d) + n * DAY);
const days = (start, count) => Array.from({ length: count }, (_, i) => addDays(start, i));
// Monday of the week containing d.
export const weekStart = d => addDays(d, -((new Date(toMs(d)).getUTCDay() + 6) % 7));
const money = v => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const workerKey = w => String(w?.id || w?.contactId || w?.phone || w?.name || '').trim().toLowerCase();

// Each job counts on every day from its report date through its end date (capped at 60 days).
function jobSpan(data) {
  const start = data?.reportDate;
  if (!isDate(start)) return [];
  let end = isDate(data.reportEndDate) && data.reportEndDate >= start ? data.reportEndDate : start;
  if (toMs(end) - toMs(start) > 59 * DAY) end = addDays(start, 59);
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function scheduleStats(rows, today, span = 14) {
  const labels = days(today, span);
  const jobs = new Map(labels.map(d => [d, 0]));
  const crew = new Map(labels.map(d => [d, new Set()]));
  for (const r of rows) {
    if (!r.active || r.data?.status === 'cancelled' || r.data?.status === 'completed') continue;
    for (const d of jobSpan(r.data)) {
      if (!jobs.has(d)) continue;
      jobs.set(d, jobs.get(d) + 1);
      for (const w of Array.isArray(r.data.crew) ? r.data.crew : []) { const k = workerKey(w); if (k) crew.get(d).add(k); }
    }
  }
  return {
    chartJobs: { labels, series: [{ key: 'jobs', name: 'Jobs on site', values: labels.map(d => jobs.get(d)) }] },
    chartCrew: { labels, series: [{ key: 'crew', name: 'Workers booked', values: labels.map(d => crew.get(d).size) }] }
  };
}

// Job value (monetaryValue) by the week the job starts: last 8 weeks and the next 4. Cancelled jobs are left out.
export function valueStats(rows, today) {
  const thisWeek = weekStart(today);
  const labels = Array.from({ length: 12 }, (_, i) => addDays(thisWeek, (i - 8) * 7));
  const sums = new Map(labels.map(d => [d, 0]));
  for (const r of rows) {
    if (r.data?.status === 'cancelled' || !isDate(r.data?.reportDate)) continue;
    const wk = weekStart(r.data.reportDate);
    if (sums.has(wk)) sums.set(wk, sums.get(wk) + money(r.data.monetaryValue));
  }
  return { labels, currentIndex: 8, series: [{ key: 'value', name: 'Job value', values: labels.map(d => Math.round(sums.get(d))) }] };
}

// Make runs per day for the last 14 days: confirmed cleanly vs. needed attention
// (failed, timed out, still open, or cleared by hand with Acknowledge).
export async function healthStats(sql, today) {
  const labels = days(addDays(today, -13), 14);
  const rows = await sql`select (created_at at time zone ${TZ()})::date::text as day,
      count(*) filter (where status = 'confirmed' and last_error is null)::int as ok,
      count(*) filter (where not (status = 'confirmed' and last_error is null))::int as bad
    from dispatch_effects where created_at >= now() - interval '15 days' group by 1`;
  const by = new Map(rows.map(r => [r.day, r]));
  return { labels, stacked: true, series: [
    { key: 'ok', name: 'Went through', values: labels.map(d => by.get(d)?.ok || 0) },
    { key: 'bad', name: 'Needed attention', values: labels.map(d => by.get(d)?.bad || 0) }
  ] };
}

export async function dashboardStats(sql, can) {
  const today = localToday();
  const out = { today };
  const wantSchedule = can('chartJobs') || can('chartCrew'), wantValue = can('chartValue');
  if (wantSchedule || wantValue) {
    const rows = await sql`select job_id, data, active from job_shared_state`;
    if (wantSchedule) { const s = scheduleStats(rows, today); if (can('chartJobs')) out.chartJobs = s.chartJobs; if (can('chartCrew')) out.chartCrew = s.chartCrew; }
    if (wantValue) out.chartValue = valueStats(rows, today);
  }
  if (can('chartHealth')) out.chartHealth = await healthStats(sql, today);
  return out;
}
