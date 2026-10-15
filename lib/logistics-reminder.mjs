// Afternoon Logistics reminder (3pm Pacific by default): tomorrow's moves that
// still have no saved time, no driver or no vehicle. Sent to the
// logistics_reminder webhook only when something is missing, once a day.
import { moveRecord, jobRecord } from './store.mjs';
import { queueEffectNow, sendHeldEffects } from './effect-queue.mjs';

const TZ = () => process.env.BOARD_TIME_ZONE || 'America/Los_Angeles';
export const reminderHour = () => { const h = Number(process.env.LOGISTICS_REMINDER_HOUR); return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 15; };
export function boardNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const dayLabel = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); };
const clock = hhmm => { const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || ''); if (!m) return ''; const h = +m[1]; return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`; };
const pretty = v => String(v || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const isOpen = m => m.active !== false && !/complete|cancel|lost|abandon/i.test(String(m.status || ''));

// Moves on `date` with what each one is missing. `moves` are move records (moveRecord shape).
export function reminderFor(moves, date, { boardUrl = '' } = {}) {
  const list = moves.filter(isOpen).filter(m => (m.scheduledDate || m.requestedDate || m.reportDate || '') === date)
    .map(m => {
      const time = m.scheduledTime || m.requestedTime || m.reportTime || '';
      const vehicles = (Array.isArray(m.assets) && m.assets.length ? m.assets.map(a => a.assetName || a.assetId) : (m.assetName || m.assetId ? [m.assetName || m.assetId] : [])).filter(Boolean);
      const driverName = String(m.driverName || '').trim();
      const missingTime = !m.scheduledDate || !time, missingDriver = !driverName, missingVehicle = !vehicles.length;
      const missing = [missingTime ? 'time' : '', missingDriver ? 'driver' : '', missingVehicle ? 'vehicle' : ''].filter(Boolean);
      return {
        moveId: String(m.moveId || ''), jobId: String(m.sourceOpportunityId || m.opportunityId || m.jobId || ''),
        jobAddress: m.jobAddress || m.destinationAddress || '', clientName: m.companyName || m.clientName || '',
        movementType: pretty(m.movementType || m.addonType || 'move'), equipment: m.containerSize || m.equipment || '',
        time, timeLabel: clock(time), driverName, vehicles: vehicles.join(', '),
        missingTime, missingDriver, missingVehicle, missing: missing.join(', '), ready: !missing.length
      };
    })
    .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  const needs = list.filter(m => !m.ready);
  const counts = { missingTimeCount: needs.filter(m => m.missingTime).length, missingDriverCount: needs.filter(m => m.missingDriver).length, missingVehicleCount: needs.filter(m => m.missingVehicle).length };
  const parts = [counts.missingDriverCount ? `${counts.missingDriverCount} no driver` : '', counts.missingVehicleCount ? `${counts.missingVehicleCount} no vehicle` : '', counts.missingTimeCount ? `${counts.missingTimeCount} no time` : ''].filter(Boolean);
  const label = dayLabel(date);
  return {
    action: 'logistics_reminder', date, dayLabel: label,
    totalMoves: list.length, readyMoves: list.length - needs.length, needsAttention: needs.length, ...counts,
    summary: needs.length ? `${needs.length} of ${list.length} moves for ${label} need attention: ${parts.join(', ')}.` : `All ${list.length} moves for ${label} are ready.`,
    movesText: needs.map(m => `${m.timeLabel || 'No time'} · ${m.movementType}${m.equipment ? ' (' + m.equipment + ')' : ''} · ${m.jobAddress || m.clientName || m.moveId} · missing ${m.missing}`).join('\n'),
    moves: needs, boardUrl
  };
}

// Labor side, same payload fields as the logistics reminder so the same Make
// mapping (summary, movesText) works. For a job: missingDriver = no crew,
// missingVehicle = crew short of its crew size, missingTime = no start or end
// time. driverName = the crew's names, vehicles = "2 of 4 crew".
export function laborReminderFor(jobs, date, { boardUrl = '' } = {}) {
  const list = jobs.filter(isOpen).filter(j => (j.reportDate || '') === date)
    .map(j => {
      const crew = (Array.isArray(j.crew) ? j.crew : []).map(w => String((w && (w.name || w.workerName)) || '').trim()).filter(Boolean);
      const size = Math.max(0, Number(j.crewSize) || 0);
      const time = j.reportTime || '';
      const missingTime = !time || !j.reportEndTime, missingDriver = !crew.length, missingVehicle = !!size && crew.length > 0 && crew.length < size;
      const missing = [missingTime ? 'time' : '', missingDriver ? 'crew' : '', missingVehicle ? `short crew (${crew.length} of ${size})` : ''].filter(Boolean);
      return {
        moveId: String(j.jobId || ''), jobId: String(j.jobId || ''),
        jobAddress: j.jobAddress || j.closedJobName || '', clientName: j.clientName || '',
        movementType: j.nightWork === true || j.nightWork === 'true' ? 'Labor job (night)' : 'Labor job', equipment: size ? `crew of ${size}` : '',
        time, timeLabel: clock(time), driverName: crew.join(', '), vehicles: size ? `${crew.length} of ${size} crew` : `${crew.length} crew`,
        missingTime, missingDriver, missingVehicle, missing: missing.join(', '), ready: !missing.length
      };
    })
    .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  const needs = list.filter(m => !m.ready);
  const counts = { missingTimeCount: needs.filter(m => m.missingTime).length, missingDriverCount: needs.filter(m => m.missingDriver).length, missingVehicleCount: needs.filter(m => m.missingVehicle).length };
  const parts = [counts.missingDriverCount ? `${counts.missingDriverCount} no crew` : '', counts.missingVehicleCount ? `${counts.missingVehicleCount} short crew` : '', counts.missingTimeCount ? `${counts.missingTimeCount} no time` : ''].filter(Boolean);
  const label = dayLabel(date);
  return {
    action: 'labor_reminder', date, dayLabel: label,
    totalMoves: list.length, readyMoves: list.length - needs.length, needsAttention: needs.length, ...counts,
    summary: needs.length ? `${needs.length} of ${list.length} labor jobs for ${label} need attention: ${parts.join(', ')}.` : `All ${list.length} labor jobs for ${label} are ready.`,
    movesText: needs.map(m => `${m.timeLabel || 'No time'} · ${m.movementType}${m.equipment ? ' (' + m.equipment + ')' : ''} · ${m.jobAddress || m.clientName || m.jobId} · missing ${m.missing}`).join('\n'),
    moves: needs, boardUrl
  };
}
export async function runLaborReminder(sql, { force = false, now = new Date(), boardUrl = process.env.URL || '' } = {}) {
  const { date: today, hour } = boardNow(now);
  if (!force && hour !== reminderHour()) return { sent: false, reason: `not ${reminderHour()}:00 Pacific` };
  const date = addDays(today, 1);
  const rows = await sql`select * from job_shared_state where active = true`;
  const payload = { ...laborReminderFor(rows.map(jobRecord), date, { boardUrl }), forced: !!force, sentAt: now.toISOString(), jobId: `labor-${date}` };
  if (!payload.needsAttention) return { sent: false, reason: 'everything for tomorrow is ready', payload };
  if (!force) {
    const claimed = await sql`insert into dispatch_settings (key, value, updated_by) values (${'labor-reminder:' + date}, ${sql.json(true)}, 'reminder')
      on conflict (key) do nothing returning key`;
    if (!claimed.length) return { sent: false, reason: 'already sent today', payload };
  }
  const effectId = await queueEffectNow(sql, { kind: 'labor_reminder', payload, effectKey: date });
  const result = await sendHeldEffects(sql, { ids: [effectId], timeoutMs: 25000 });
  return { sent: result.sent.includes(effectId), confirmed: result.sent.includes(effectId), payload };
}
// Both reminders (logistics, then labor), each on its own run.
export async function runAllReminders(sql, options = {}) {
  const logistics = await runLogisticsReminder(sql, options);
  const labor = await runLaborReminder(sql, options);
  return { logistics, labor };
}

// Sends tomorrow's reminder if anything is missing. force: skip the hour check
// and the once a day guard (the "Send now" button). Returns what happened.
export async function runLogisticsReminder(sql, { force = false, now = new Date(), boardUrl = process.env.URL || '' } = {}) {
  const { date: today, hour } = boardNow(now);
  if (!force && hour !== reminderHour()) return { sent: false, reason: `not ${reminderHour()}:00 Pacific` };
  const date = addDays(today, 1);
  const rows = await sql`select * from logistics_move_state`;
  const payload = { ...reminderFor(rows.map(moveRecord), date, { boardUrl }), forced: !!force, sentAt: now.toISOString(), jobId: `logistics-${date}` };
  if (!payload.needsAttention) return { sent: false, reason: 'everything for tomorrow is ready', payload };
  if (!force) {
    const claimed = await sql`insert into dispatch_settings (key, value, updated_by) values (${'logistics-reminder:' + date}, ${sql.json(true)}, 'reminder')
      on conflict (key) do nothing returning key`;
    if (!claimed.length) return { sent: false, reason: 'already sent today', payload };
  }
  const effectId = await queueEffectNow(sql, { kind: 'logistics_reminder', payload, effectKey: date });
  const result = await sendHeldEffects(sql, { ids: [effectId], timeoutMs: 25000 });
  return { sent: result.sent.includes(effectId), confirmed: result.sent.includes(effectId), payload };
}
