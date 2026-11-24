// Crew schedule text (action crewText), done on the server.
//
// Sent 12 hours before the job starts (or right away inside the 12 hours) and by Send now
// (lib/daily-dispatch.mjs), and by Send schedule now in the crew picker. Each worker gets the schedule for their job only
// (day, date, that job, sign off), once per job and day (crew_text_log), through Twilio, and logs each text in that worker's GHL
// conversation the same way the Triple Line dialer logs its calls: the Marketplace
// app's location OAuth token + a Conversation Provider (type SMS), added to the
// worker's conversation with /conversations/messages/inbound, direction "outbound",
// and the Twilio SID as altId.
//
// Env:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN          required
//   TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID  one is required (service wins)
//   GHL_APP_CLIENT_ID, GHL_APP_CLIENT_SECRET       Marketplace app keys (token refresh)
//   GHL_SMS_CONVERSATION_PROVIDER_ID               SMS Conversation Provider in that app
//   GHL_LOCATION_ID                                optional (A2Z's location is the default)
//   CREW_TEXT_DRY_RUN=true                         optional: build and record, send nothing
//   CREW_TEXT_GHL_LOG=false                        optional: text through Twilio only
//
// Each step (text, Twilio part, GHL log) is recorded per run in crew_text_sends, so a
// Retry from Admin > Make / GHL problems only redoes what didn't finish and sends the
// same text the first try built. Nobody gets the same text twice.
import { ghl } from './ghl.mjs';

const DEFAULT_LOCATION_ID = 'QUcu2PEAxPV1sQm1GQCq';
const locationId = () => process.env.GHL_LOCATION_ID || DEFAULT_LOCATION_ID;
export const SCHEDULE_TEXT_SIGNOFF = 'buenas noches guys';

// ---------- Editable text layout (Admin > Crew schedule text) ----------
// The text each worker gets is built from a template a senior admin can edit. Saved in
// dispatch_settings under "crewTextTemplate" as { template, crewLine }. The default
// below gives exactly the text the board always sent.
// A line whose fields all come out empty (no end time, not hourly, no address) is left
// out; if it stood alone between blank lines, one of those goes too, so spacing stays the same.
export const CREW_TEXT_DEFAULT = Object.freeze({
  template: '{DAY}\n\n{DATE}\n\n\n\n{HOURLY}\n\n({CLIENT})\n\n{ADDRESS}\n\n{TIME}\n\n{CREW}\n\n\n\n' + SCHEDULE_TEXT_SIGNOFF,
  crewLine: '* {NAME}{SPLIT}'
});
export const CREW_TEXT_FIELDS = Object.freeze({
  DAY: 'Day, all caps (TUESDAY)', WEEKDAY: 'Day (Tuesday)', DATE: 'Date (Nov 3, 2026)',
  HOURLY: '"(HOURLY)" on hourly jobs, nothing on contract jobs', CLIENT: 'Client name', ADDRESS: 'Job address',
  TIME: 'Start - end (7:00 AM - 3:30 PM)', START: 'Start time', END: 'End time', SHIFT: '"NIGHT SHIFT" on night jobs, nothing on day jobs',
  SCOPE: 'Scope of work', CREW: 'The crew, one line each (see crew line)'
});
export const CREW_LINE_FIELDS = Object.freeze({ NAME: 'Worker name', SPLIT: '" 4hr" when split between jobs that day, else nothing', HOURS: 'Split hours ("4"), else nothing' });
export const CREW_TEXT_MAX = 1200;
const FIELD_RE = /\{([A-Za-z_]+)\}/g;
function checkFields(text, allowed, where) {
  const bad = [...new Set([...text.matchAll(FIELD_RE)].map(m => m[1]).filter(k => !Object.hasOwn(allowed, k)))];
  if (bad.length) throw Object.assign(new Error(`${where} has fields the text doesn't know: ${bad.map(b => '{' + b + '}').join(', ')}. Use: ${Object.keys(allowed).map(k => '{' + k + '}').join(' ')}`), { status: 400 });
  const opens = (text.match(/\{/g) || []).length, closes = (text.match(/\}/g) || []).length;
  if (opens !== closes) throw Object.assign(new Error(`${where} has a { or } without its pair.`), { status: 400 });
}
// Checks what a senior admin typed. Returns the cleaned layout or throws (status 400).
export function cleanCrewText(input) {
  const template = String(input?.template ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\s+$/g, '');
  const crewLine = String(input?.crewLine ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!template) throw Object.assign(new Error('The text layout is empty.'), { status: 400 });
  if (template.length > CREW_TEXT_MAX) throw Object.assign(new Error(`The text layout is too long (${template.length} of ${CREW_TEXT_MAX} characters).`), { status: 400 });
  checkFields(template, CREW_TEXT_FIELDS, 'The text layout');
  if (!crewLine) throw Object.assign(new Error('The crew line is empty.'), { status: 400 });
  if (crewLine.length > 120) throw Object.assign(new Error('The crew line is too long (120 characters at most).'), { status: 400 });
  checkFields(crewLine, CREW_LINE_FIELDS, 'The crew line');
  if (!/\{NAME\}/.test(crewLine)) throw Object.assign(new Error('The crew line needs {NAME}.'), { status: 400 });
  const warnings = [];
  if (!/\{CREW\}/.test(template)) warnings.push('No {CREW}: workers won\'t see who else is on the job.');
  if (!/\{DATE\}|\{DAY\}|\{WEEKDAY\}/.test(template)) warnings.push('No {DATE} or {DAY}: the text won\'t say which day.');
  if (!/\{ADDRESS\}/.test(template)) warnings.push('No {ADDRESS}: the text won\'t say where to go.');
  if (!/\{TIME\}|\{START\}/.test(template)) warnings.push('No {TIME} or {START}: the text won\'t say when to show up.');
  return { template, crewLine, warnings };
}
// The saved layout, or the default if none is saved or it can't be read (never fails a send).
export async function readCrewText(sql) {
  try {
    const [row] = await sql`select value from dispatch_settings where key = 'crewTextTemplate'`;
    const v = row && (typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
    if (!v) return { ...CREW_TEXT_DEFAULT };
    const { template, crewLine } = cleanCrewText(v);
    return { template, crewLine };
  } catch { return { ...CREW_TEXT_DEFAULT }; }
}
const fill = (text, values) => text.replace(FIELD_RE, (m, k) => Object.hasOwn(values, k) ? String(values[k] ?? '') : m);
export function renderCrewText(values, layout = CREW_TEXT_DEFAULT) {
  const crew = (values.crew || []).map(w => fill(layout.crewLine, { NAME: w.name, SPLIT: w.hours ? ` ${w.hours}hr` : '', HOURS: w.hours ? String(w.hours) : '' }).trim()).join('\n');
  const vals = { ...values, CREW: crew };
  const out = [];
  const lines = layout.template.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], fields = [...line.matchAll(FIELD_RE)].map(m => m[1]);
    const text = fill(line, vals);
    if (fields.length && fields.every(k => !String(vals[k] ?? '').trim())) {
      // Leave out the line. If it was a paragraph on its own (blank lines on both
      // sides), also drop one of those blank lines so the spacing stays the same.
      const prevBlank = !out.length || !out[out.length - 1].trim();
      const nextBlank = i + 1 >= lines.length || !lines[i + 1].trim();
      if (prevBlank && nextBlank) {
        if (i + 1 < lines.length) i++;
        else if (out.length) out.pop();
      }
      continue;
    }
    out.push(text);
  }
  return out.join('\n').replace(/^\s+|\s+$/g, '');
}
// How many texts a message is billed as (Twilio segments): 160 / 153 characters with
// the plain SMS alphabet, 70 / 67 once any other character (emoji, á, í, ó, ú...) is in it.
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€';
export function smsSegments(text) {
  const t = String(text || ''); if (!t) return 0;
  const gsm = [...t].every(c => GSM.includes(c));
  const len = gsm ? [...t].reduce((n, c) => n + ('^{}\\[~]|€'.includes(c) ? 2 : 1), 0) : [...t].length;
  const [one, many] = gsm ? [160, 153] : [70, 67];
  return len <= one ? 1 : Math.ceil(len / many);
}
// Sample values for the admin preview (the example from the board).
export const CREW_TEXT_SAMPLE = Object.freeze({
  DAY: 'TUESDAY', WEEKDAY: 'Tuesday', DATE: 'Nov 3, 2026', HOURLY: '', CLIENT: 'Kyle Matt', ADDRESS: '267 E 16th St, Costa Mesa, CA 92627',
  TIME: '7:00 AM - 3:30 PM', START: '7:00 AM', END: '3:30 PM', SHIFT: '', SCOPE: 'Kitchen and bath demo, haul off',
  crew: [{ name: 'Juanito Reyes' }, { name: 'Guillermo', hours: 4 }, { name: 'Jesus Reyes' }, { name: 'Jose Manuel' }]
});
const SMS_PART_LIMIT = 1500; // Twilio refuses bodies over 1600 characters.

// ---------- Building the schedule (same rules the board shows) ----------
const FIELD = {
  reportDate: process.env.REPORT_DATE_FIELD_ID || 'rY3IebKlcBhAjWlaSSQm',
  reportTime: process.env.REPORT_TIME_FIELD_ID || 'WtpFGtiB7hgmTGTsHJAW',
  reportEndTime: process.env.REPORT_END_TIME_FIELD_ID || 'XHoqx1ZNRcNRtwDCb4He'
};
const CONTRACT_PIPELINE_ID = process.env.DEMO_PIPELINE_ID || 'd5Ix1SlN3YpZ5gQewZUo';
const CONTRACT_WON_STAGE_ID = 'bb901617-1ec6-4f3c-8c77-27ccafb96404';
const has = (o, k) => !!o && Object.hasOwn(o, k);

function fieldValue(customFields, id) {
  const hit = (Array.isArray(customFields) ? customFields : []).find(f => f && f.id === id);
  if (!hit) return '';
  if (hit.fieldValueDate) { const d = new Date(hit.fieldValueDate); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); }
  return String(hit.fieldValueString || hit.fieldValue || hit.value || '');
}
function normDate(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s;
}
function normTime(raw) {
  const s = String(raw || '').trim();
  const ampm = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (ampm) return `${String(parseInt(ampm[1], 10) % 12 + (/pm/i.test(ampm[3]) ? 12 : 0)).padStart(2, '0')}:${ampm[2]}`;
  return /^\d{2}:\d{2}/.test(s) ? s.slice(0, 5) : s;
}
const pick = (state, job, key) => has(state, key) ? state[key] : fieldValue(job.customFields, FIELD[key]) || job[key] || '';
function isHourly(job, state) {
  if (job.sourceType === 'change_order' || job.sourceType === 'demo' || job.jobType === 'contract' || job.pipelineId === CONTRACT_PIPELINE_ID) return false;
  if (job.pipelineStageId === CONTRACT_WON_STAGE_ID) return false;
  if (!job.sourceType && state?.jobType === 'contract') return false;
  return true;
}
function crewOf(state) {
  let raw = state?.crew ?? [];
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = raw.split(';'); } }
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).map(w => typeof w === 'string' ? { name: w } : w || {})
    .map(w => ({ id: String(w.id || w.contactId || ''), name: String(w.name || w.workerName || '').replace(/\s+/g, ' ').trim(), phone: String(w.phone || w.workerPhone || ''), workerTimes: w.workerTimes, dontText: w.dontText === true }))
    .filter(w => { if (!w.name) return false; const k = w.id ? 'id:' + w.id : w.phone ? 'p:' + w.phone.replace(/\D/g, '') : 'n:' + w.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
export function toE164(raw) {
  const s = String(raw || '').trim(); const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (s.startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return '+' + digits;
}
function clock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '')); if (!m) return '';
  const h = +m[1] % 24;
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}
export function identityRank(a, b) {
  const id = w => String(w.contactId || w.id || '');
  const phone = w => toE164(w.workerPhone || w.phone);
  const name = w => String(w.workerName || w.name || '').trim().toLowerCase();
  if (id(a) && id(b)) return id(a) === id(b) ? 3 : 0;
  if (phone(a) && phone(b)) return phone(a) === phone(b) ? 2 : 0;
  return name(a) && name(a) === name(b) ? 1 : 0;
}

export function matchWorker(crew, worker) {
  const ranked = crew.map(w => ({ w, rank: identityRank(w, worker) }));
  const best = Math.max(0, ...ranked.map(x => x.rank));
  const matches = ranked.filter(x => x.rank === best && best > 0);
  if (matches.length !== 1) return undefined;
  if (best === 1) {
    const name = String(matches[0].w.workerName || matches[0].w.name || '').trim().toLowerCase();
    if (crew.filter(w => String(w.workerName || w.name || '').trim().toLowerCase() === name).length !== 1) return undefined;
  }
  return matches[0].w;
}

export function effectiveWorkerTimes(state, worker) {
  const date = state.reportDate || '';
  const saved = worker?.workerTimes;
  const custom = saved?.customTime === true;
  let endDate = state.reportEndDate || date;
  if (custom) {
    endDate = saved.reportEndDate || date;
    if (date && saved.reportDate && date !== saved.reportDate) {
      const offset = Date.parse(endDate) - Date.parse(saved.reportDate);
      endDate = Number.isFinite(offset) ? new Date(Date.parse(date) + offset).toISOString().slice(0, 10) : date;
    }
  }
  return { reportDate: date, reportTime: (custom ? saved.reportTime : state.reportTime) || '',
    reportEndDate: endDate, reportEndTime: (custom ? saved.reportEndTime : state.reportEndTime) || '',
    customTime: custom };
}

// jobs: the GHL job list the board shows. states: shared state records ({ jobId, active, ...data }).
// Returns { text, blocks, workers: [{ name, phone (E.164), contactId }] }.
export function buildCrewSchedule(jobs, states, date, { roster = [], layout = CREW_TEXT_DEFAULT } = {}) {
  const d = new Date(String(date || '') + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || Number.isNaN(d.getTime())) return { text: '', blocks: [], workers: [] };
  const byId = new Map((states || []).map(s => [String(s.jobId), s]));
  const day = (jobs || []).map(job => ({ job, state: byId.get(String(job.id)) }))
    .filter(({ job, state }) => state?.active !== false && normDate(pick(state, job, 'reportDate')) === date && crewOf(state).length)
    .map(({ job, state }) => {
      const night = !!(state && (state.nightWork === true || state.nightWork === 'true'));
      const hourly = isHourly(job, state);
      return { job, state, crew: crewOf(state), hourly, night, start: normTime(pick(state, job, 'reportTime')), end: normTime(pick(state, job, 'reportEndTime')), group: night ? 2 : hourly ? 1 : 0 };
    })
    .sort((a, b) => a.group - b.group || (a.start || '99:99').localeCompare(b.start || '99:99') || String(a.job.name || '').localeCompare(String(b.job.name || '')));
  const header = [
    d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toUpperCase(),
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
    `${day.length} ${day.length === 1 ? 'job' : 'jobs'}`
  ].join('\n\n');
  const blocks = day.map(({ job, crew, hourly, start, end }) => {
    const parts = [];
    if (hourly) parts.push('(HOURLY)');
    parts.push(`(${(job.contact && job.contact.name) || job.clientName || 'No client'})`);
    if (job.name) parts.push(job.name);
    if (start || end) parts.push([clock(start), clock(end)].filter(Boolean).join(' - '));
    // Split day: a worker on more than one job this day shows "Name 4hr" (8 hrs split evenly).
    parts.push(crew.map(w => {
      const count = day.filter(o => matchWorker(o.crew, w)).length;
      return count > 1 ? `* ${w.name} ${Math.round(16 / count) / 2}hr` : `* ${w.name}`;
    }).join('\n'));
    return parts.join('\n\n');
  });
  const workers = [];
  const withPhone = w => { const fromRoster = matchWorker(roster || [], w); return { name: w.name, phone: toE164(w.phone || fromRoster?.phone || ''), contactId: w.id || fromRoster?.id || '' }; };
  for (const { crew } of day) for (const w of crew) {
    const x = withPhone(w);
    if (!x.phone || workers.some(y => y.phone === x.phone)) continue;
    workers.push(x);
  }
  // One job on its own (the text each worker gets), from the editable layout.
  const perJob = day.map(entry => {
    const { job, state, crew, hourly, night, start, end } = entry;
    const renderFor = (start, end) => renderCrewText({
      DAY: d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toUpperCase(),
      WEEKDAY: d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
      DATE: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
      HOURLY: hourly ? '(HOURLY)' : '', SHIFT: night ? 'NIGHT SHIFT' : '',
      CLIENT: (job.contact && job.contact.name) || job.clientName || 'No client', ADDRESS: job.name || '',
      TIME: (start || end) ? [clock(start), clock(end)].filter(Boolean).join(' - ') : '', START: clock(start), END: clock(end),
      SCOPE: String(state?.scopeOfWork || job.scopeOfWork || '').trim(),
      crew: crew.map(w => { const count = day.filter(o => matchWorker(o.crew, w)).length; return { name: w.name, hours: count > 1 ? Math.round(16 / count) / 2 : 0 }; })
    }, layout);
    const text = renderFor(start, end);
    const recipients = crew.map(w => {
      const times = effectiveWorkerTimes({ ...state, reportDate: date, reportTime: start, reportEndTime: end }, w);
      return { ...withPhone(w), dontText: w.dontText, text: renderFor(times.reportTime, times.reportEndTime), workerTimes: times };
    });
    return { jobId: String(job.id), text, blocks: text.split('\n\n\n\n'), workers: recipients.filter(w => w.phone), crew: recipients };
  });
  return { text: [header, ...blocks, SCHEDULE_TEXT_SIGNOFF].join('\n\n\n\n'), blocks: [header, ...blocks, SCHEDULE_TEXT_SIGNOFF], workers, jobs: perJob };
}
// The text for one job: { text, blocks, workers } (empty when the job has no crew that day).
export function buildJobText(jobs, states, date, jobId, opts) {
  const one = (buildCrewSchedule(jobs, states, date, opts).jobs || []).find(j => j.jobId === String(jobId));
  return one ? { text: one.text, blocks: one.blocks, workers: one.workers } : { text: '', blocks: [], workers: [] };
}

// Splits a long schedule into texts under Twilio's limit, breaking between jobs.
export function smsParts(blocks, limit = SMS_PART_LIMIT) {
  const parts = []; let current = '';
  for (const block of blocks) {
    const next = current ? current + '\n\n\n\n' + block : block;
    if (next.length <= limit) { current = next; continue; }
    if (current) parts.push(current);
    current = block.length <= limit ? block : '';
    if (block.length > limit) for (let i = 0; i < block.length; i += limit) parts.push(block.slice(i, i + limit));
  }
  if (current) parts.push(current);
  return parts;
}

// ---------- When it goes out ----------
// Pacific wall clock (YYYY-MM-DD, HH:MM) to a UTC timestamp.
export function pacificToUtc(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '')), t = /^(\d{1,2}):(\d{2})/.exec(String(time || ''));
  if (!m || !t) return NaN;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
  const offsetAt = ms => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms;
  };
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc); // second pass settles the DST edge
  return utc;
}
// ---------- Jobs whose date was never saved on the board ----------
// A job created in GHL has its date in a GHL field; until dispatch saves times on the board
// its shared state has no reportDate at all. The board still shows the GHL date and sends it
// with every assign run, so the newest run is used as the job's date. A record with
// reportDate set (even '' after Unschedule / EOD reset) is left as is.
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const needsRunDate = state => !!state && typeof state === 'object' && !Object.hasOwn(state, 'reportDate');
export function datesFromRun(state, payload) {
  if (!needsRunDate(state) || !payload || !YMD.test(String(payload.reportDate || ''))) return state;
  const next = { ...state, datesFrom: 'run' };
  for (const k of ['reportDate', 'reportTime', 'reportEndDate', 'reportEndTime']) next[k] = String(payload[k] || '');
  if (!Object.hasOwn(state, 'nightWork') && payload.nightWork != null) next.nightWork = payload.nightWork === true || payload.nightWork === 'true';
  return next;
}
// states: Map jobId -> state. Fills in place; one query, and only when a job needs it.
export async function fillRunDates(sql, states) {
  const ids = [...states].filter(([, s]) => needsRunDate(s)).map(([id]) => String(id));
  if (!ids.length) return states;
  const rows = await sql`select distinct on (payload->>'jobId') payload->>'jobId' as job_id, payload from dispatch_effects
    where kind in ('workers', 'split_day') and payload->>'jobId' = any(${ids}) and payload->>'reportDate' ~ ${'^\\d{4}-\\d{2}-\\d{2}$'}
    order by payload->>'jobId', created_at desc`;
  for (const r of rows) states.set(r.job_id, datesFromRun(states.get(r.job_id), typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
  return states;
}

// Older assignments recorded custom hours only in the run. Use the latest assign
// for that worker until the crew entry has its own saved hours.
export async function fillScheduleState(sql, states) {
  await fillRunDates(sql, states);
  const ids = [...states].filter(([, s]) => Array.isArray(s?.crew) && s.crew.some(w => w && !w.workerTimes)).map(([id]) => id);
  if (!ids.length) return states;
  const rows = await sql`select payload from dispatch_effects
    where kind in ('workers', 'split_day') and payload->>'action' in ('assign', 'rapid_assign', 'split_day_assign')
      and (payload->>'jobId' = any(${ids}) or payload->>'jobId2' = any(${ids}))
    order by created_at desc, effect_id desc`;
  const runs = rows.map(r => typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload);
  for (const id of ids) {
    const state = states.get(id);
    const crew = state.crew.filter(w => w && typeof w === 'object');
    const byWorker = new Map();
    for (const p of runs) {
      if (p.jobId !== id && p.jobId2 !== id) continue;
      const worker = matchWorker(crew, p);
      if (!worker || worker.workerTimes || byWorker.has(worker)) continue;
      const suffix = p.jobId === id ? '' : '2';
      const times = p['customTime' + suffix] === true ? {
        reportDate: p['workerReportDate' + suffix],
        reportTime: p['workerReportTime' + suffix],
        reportEndDate: p['workerReportEndDate' + suffix],
        reportEndTime: p['workerReportEndTime' + suffix],
        customTime: true
      } : null;
      byWorker.set(worker, times);
    }
    states.set(id, { ...state, crew: state.crew.map(w => byWorker.get(w) ? { ...w, workerTimes: byWorker.get(w) } : w) });
  }
  return states;
}

// ---------- Loading the day from the database ----------
export async function loadDay(sql, date) {
  const [cache] = await sql`select data from dispatch_feed_cache where key = 'ghl-jobs'`;
  const cached = cache && (typeof cache.data === 'string' ? JSON.parse(cache.data) : cache.data);
  const rows = await sql`select job_id, active, data from job_shared_state where active = true`;
  const byId = await fillScheduleState(sql, new Map(rows.map(r => [r.job_id, typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {})])));
  const states = rows.map(r => ({ ...byId.get(r.job_id), jobId: r.job_id, active: r.active }));
  // Same job list the board shows (the shared GHL feed). If it has never loaded, use the saved job details.
  const fromState = s => ({ id: s.jobId, name: s.jobAddress || '', clientName: s.clientName || '', jobType: s.jobType || '', customFields: [] });
  const jobs = Array.isArray(cached) ? [...cached] : states.map(fromState);
  // A job on the board that the cached GHL feed doesn't list (new since the last feed load,
  // or moved to another GHL stage) used to get no text at all, silently. Use its saved details.
  const listed = new Set(jobs.map(j => String(j?.id)));
  for (const s of states) if (!listed.has(String(s.jobId))) jobs.push(fromState(s));
  return buildCrewSchedule(jobs, states, date, { layout: await readCrewText(sql) });
}

// ---------- Twilio ----------
// Twilio reports delivered / undelivered / failed for each text to /api/crew-text-status
// (netlify/functions/crew-text-status.mjs), shown in Admin > Schedule text tracker.
export function statusCallbackUrls() {
  return [process.env.URL, process.env.PUBLIC_APP_URL].map(b => String(b || '').replace(/\/$/, '')).filter(Boolean).map(b => `${b}/api/crew-text-status`);
}
export const statusCallbackUrl = () => flag('CREW_TEXT_STATUS_CALLBACK', true) ? statusCallbackUrls()[0] || '' : '';
function need(name) { const v = process.env[name]; if (!v) throw new Error(`${name} is not set in Netlify`); return v; }
async function twilioSms(to, body) {
  const sid = need('TWILIO_ACCOUNT_SID'), token = need('TWILIO_AUTH_TOKEN');
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID, from = process.env.TWILIO_FROM_NUMBER;
  if (!service && !from) throw new Error('TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID must be set in Netlify');
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, Body: body, ...(service ? { MessagingServiceSid: service } : { From: from }), ...(statusCallbackUrl() ? { StatusCallback: statusCallbackUrl() } : {}) })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.sid) throw new Error(`Twilio ${response.status}: ${result.message || 'message not accepted'}`);
  return { sid: result.sid, from: result.from || from || '' };
}

// ---------- GHL (Marketplace OAuth, same as the dialer) ----------
const oauthKey = loc => `ghl-oauth:${loc}`;
export async function oauthTokenRequest(fields) {
  const response = await fetch('https://services.leadconnectorhq.com/oauth/token', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json', Version: 'v3', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: need('GHL_APP_CLIENT_ID'), client_secret: need('GHL_APP_CLIENT_SECRET'), ...fields })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new Error(`GHL OAuth: ${result.message || result.error || response.status}`);
  return { ...result, locationId: result.locationId || result.location_id || '', companyId: result.companyId || result.company_id || '', expiresAt: Date.now() + Math.max(Number(result.expires_in) || 86400, 60) * 1000 };
}
export async function locationTokenFromAgency(agencyToken, loc) {
  if (!agencyToken.companyId) throw new Error('GHL OAuth returned neither a location ID nor a company ID');
  const response = await fetch('https://services.leadconnectorhq.com/oauth/location-token', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json', Authorization: `Bearer ${agencyToken.access_token}`, Version: 'v3', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ companyId: agencyToken.companyId, locationId: loc })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new Error(`GHL location OAuth: ${result.message || result.error || response.status}`);
  return { ...result, locationId: result.locationId || result.location_id || loc, companyId: agencyToken.companyId, expiresAt: Date.now() + Math.max(Number(result.expires_in) || 86400, 60) * 1000 };
}
export async function saveOauthToken(sql, token) {
  await sql`insert into dispatch_settings (key, value, updated_by) values (${oauthKey(token.locationId)}, ${sql.json(token)}, 'oauth')
    on conflict (key) do update set value = excluded.value, updated_by = 'oauth', updated_at = now()`;
}
async function readOauthToken(sql, loc) {
  const [row] = await sql`select value from dispatch_settings where key = ${oauthKey(loc)}`;
  return row && (typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
}
// GHL refresh tokens work once. Crew texts go out several at a time, so only one refresh
// per location runs in this function at once; the others wait for it and use its token.
const refreshing = new Map();
async function marketplaceToken(sql, loc, force = false) {
  let token = await readOauthToken(sql, loc);
  if (!token?.refresh_token) throw new Error('GHL Marketplace app is not connected for this location. Install (or update) the dispatch board Marketplace app so /api/oauth/callback can save its token.');
  if (!force && token.access_token && Number(token.expiresAt) > Date.now() + 60000) return token.access_token;
  if (!refreshing.has(loc)) {
    const used = token.refresh_token;
    refreshing.set(loc, (async () => {
      try {
        const next = await oauthTokenRequest({ grant_type: 'refresh_token', refresh_token: used, user_type: 'Location' });
        if (!next.locationId) next.locationId = loc;
        await saveOauthToken(sql, next);
        return next;
      } catch (error) {
        // Another function (12 hour timer, a second board, Send now) may have refreshed first.
        // Its new token is already saved, so use it instead of failing.
        const saved = await readOauthToken(sql, loc);
        if (saved?.refresh_token && saved.refresh_token !== used && saved.access_token) return saved;
        throw error;
      }
    })().finally(() => refreshing.delete(loc)));
  }
  return (await refreshing.get(loc)).access_token;
}
async function marketplaceGhl(sql, loc, path, options, retry = true) {
  const response = await fetch(`https://services.leadconnectorhq.com${path}`, {
    ...options, signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json', Authorization: `Bearer ${await marketplaceToken(sql, loc)}`, Version: 'v3', 'Content-Type': 'application/json' }
  });
  if (response.status === 401 && retry) { await marketplaceToken(sql, loc, true); return marketplaceGhl(sql, loc, path, options, false); }
  const raw = await response.text(); let result = {}; try { result = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(`GHL ${response.status}: ${[result.message].flat().filter(Boolean).join('; ') || result.error || raw.slice(0, 160)}`);
  return result;
}
async function contactIdFor(worker) {
  if (worker.contactId) return worker.contactId;
  const payload = await ghl(`/contacts/search/duplicate?${new URLSearchParams({ locationId: locationId(), number: worker.phone })}`, { timeoutMs: 5000 });
  return payload?.contact?.id || '';
}
// The worker's GHL conversation (made if they don't have one yet).
async function conversationIdFor(sql, contactId) {
  const loc = locationId();
  const found = await marketplaceGhl(sql, loc, `/conversations/search?${new URLSearchParams({ locationId: loc, contactId, limit: '1' })}`, { method: 'GET' });
  const existing = (found?.conversations || [])[0]?.id;
  if (existing) return existing;
  const made = await marketplaceGhl(sql, loc, '/conversations/', { method: 'POST', body: JSON.stringify({ locationId: loc, contactId }) });
  const id = made?.conversation?.id || made?.id;
  if (!id) throw new Error('GHL did not return a conversation for this contact');
  return id;
}
// GHL's /conversations/messages/outbound only takes calls (that's what the dialer posts).
// A text sent outside GHL is added with /conversations/messages/inbound and
// direction "outbound": it shows as a sent SMS in the worker's conversation and
// GHL does not send anything itself.
async function logToGhl(sql, worker, part, sms) {
  const conversationProviderId = need('GHL_SMS_CONVERSATION_PROVIDER_ID');
  const contactId = await contactIdFor(worker);
  if (!contactId) throw new Error(`no GHL contact found for ${worker.phone}`);
  const conversationId = await conversationIdFor(sql, contactId);
  const result = await marketplaceGhl(sql, locationId(), '/conversations/messages/inbound', {
    method: 'POST',
    body: JSON.stringify({ type: 'SMS', direction: 'outbound', conversationId, conversationProviderId, altId: sms.sid, date: new Date().toISOString(), message: part })
  });
  return result?.messageId || result?.id || result?.message?.id || 'logged';
}

// ---------- The run ----------
export async function ensureTable(sql) {
  await sql`create table if not exists crew_text_sends (
    effect_id text not null, phone text not null, step text not null, ref text not null default '', created_at timestamptz not null default now(),
    primary key (effect_id, phone, step))`;
  // Who already got the schedule text for a job and day, so nobody gets it twice.
  await sql`create table if not exists crew_text_log (
    job_id text not null, report_date text not null, phone text not null, effect_id text not null default '', created_at timestamptz not null default now(),
    primary key (job_id, report_date, phone))`;
  // Twilio delivery reports, per message SID.
  await sql`create table if not exists crew_text_status (
    sid text primary key, status text not null default '', error_code text not null default '', phone text not null default '', updated_at timestamptz not null default now())`;
}
export async function textedPhones(sql, jobId, date) {
  await ensureTable(sql);
  return new Set((await sql`select phone from crew_text_log where job_id = ${String(jobId)} and report_date = ${String(date)}`).map(r => r.phone));
}
const flag = (name, dflt) => { const v = process.env[name]; return v == null || v === '' ? dflt : !/^(false|0|no|off)$/i.test(v); };

export async function sendCrewText(payload, effectId, { sql } = {}) {
  if (!sql) { const { db, ensureSchema } = await import('../netlify/functions/db.mjs'); sql = db(); await ensureSchema(sql); }
  await ensureTable(sql);
  const id = String(effectId || `crew-text:${payload.jobId}:${payload.reportDate}`);
  const done = new Map((await sql`select phone, step, ref from crew_text_sends where effect_id = ${id}`).map(r => [`${r.phone}|${r.step}`, r.ref]));
  const mark = async (phone, step, ref) => { await sql`insert into crew_text_sends (effect_id, phone, step, ref) values (${id}, ${phone}, ${step}, ${String(ref)}) on conflict do nothing`; done.set(`${phone}|${step}`, String(ref)); };

  // The first try decides the text and who gets it; a retry reuses both.
  let plan = done.get('*|plan');
  if (plan) plan = JSON.parse(plan);
  else {
    const date = String(payload.reportDate || '');
    const day = await loadDay(sql, date);
    // The text is that job only. Only the workers listed (payload.textWorkers) who are
    // still on the job and haven't already gotten this job's text for that day get it.
    // manual: Text crew on the job row (one worker, held and confirmed), sent even with Don't text.
    // A run without textWorkers (a board tab opened before this update) texts nobody.
    const listed = Array.isArray(payload.textWorkers) ? payload.textWorkers.filter(w => toE164(w?.workerPhone || w?.phone || '')) : [];
    const job = (day.jobs || []).find(j => j.jobId === String(payload.jobId));
    // Used to end as "confirmed" with nobody texted. Now it shows in Make / GHL problems.
    if (!job && listed.length) throw new Error(`Crew text: job ${payload.jobAddress || payload.jobId} is not on the ${date || '(no date)'} schedule (its date changed, or it has no crew that day). Nobody was texted. Check the job's date, then use Send now on the job.`);
    if (!job) return { fileName: '', sent: 0 };
    const workers = [];
    for (const w of Array.isArray(payload.textWorkers) ? payload.textWorkers : []) {
      const phone = toE164(w?.workerPhone || w?.phone || '');
      if (!phone || workers.some(x => x.phone === phone)) continue;
      const onJob = matchWorker(job.crew, w);
      if (!onJob || (onJob.dontText && payload.manual !== true) || (onJob.phone && onJob.phone !== phone)) continue;
      // A number shared by different contacts cannot safely receive personalized schedules.
      if (job.crew.some(other => other !== onJob && other.phone === phone)) continue;
      // Claim the text for this job, day and phone before Twilio is called, so two sends
      // running at the same time (two boards, the 12 hour timer, Send now) can't both text them.
      const got = await sql`insert into crew_text_log (job_id, report_date, phone, effect_id) values (${String(payload.jobId)}, ${date}, ${phone}, ${id}) on conflict do nothing returning phone`;
      if (!got.length) {
        const [owner] = await sql`select effect_id from crew_text_log where job_id = ${String(payload.jobId)} and report_date = ${date} and phone = ${phone}`;
        if (owner?.effect_id !== id) continue;
      }
      workers.push({ name: String(w.workerName || w.name || onJob.name || ''), phone, contactId: String(w.contactId || onJob.contactId || ''), parts: smsParts(onJob.text.split('\n\n\n\n')) });
    }
    plan = { workers };
    await mark('*', 'plan', JSON.stringify(plan));
  }
  if (!plan.workers.length) return { fileName: '', sent: 0 };
  const dryRun = flag('CREW_TEXT_DRY_RUN', false), logGhl = flag('CREW_TEXT_GHL_LOG', true);
  const errors = [];
  const runWorker = async worker => {
    const parts = worker.parts || plan.parts; // Existing retry plans have shared parts.
    for (let i = 0; i < parts.length; i++) {
      let sms = done.has(`${worker.phone}|sms:${i}`) ? JSON.parse(done.get(`${worker.phone}|sms:${i}`)) : null;
      try {
        if (!sms) {
          sms = dryRun ? { sid: `dry-${id}-${worker.phone}-${i}`, from: '' } : await twilioSms(worker.phone, parts[i]); await mark(worker.phone, `sms:${i}`, JSON.stringify(sms));
        }
      } catch (error) { errors.push(`${worker.name}: text not sent (${error.message})`); return; }
      if (!logGhl || dryRun || done.has(`${worker.phone}|ghl:${i}`)) continue;
      try { await mark(worker.phone, `ghl:${i}`, await logToGhl(sql, worker, parts[i], sms)); }
      catch (error) { errors.push(`${worker.name}: texted, GHL log failed (${error.message})`); }
    }
  };
  // A few at a time keeps a full day of crew inside the function time limit.
  const queue = [...plan.workers];
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, async () => { while (queue.length) await runWorker(queue.shift()); }));
  if (errors.length) throw new Error(`Crew text: ${errors.slice(0, 6).join('; ')}${errors.length > 6 ? ` (+${errors.length - 6} more)` : ''}. Retry only redoes these.`);
  return { fileName: '', sent: plan.workers.length };
}
