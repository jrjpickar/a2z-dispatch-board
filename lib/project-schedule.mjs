// Project Schedule for Contract (Demo) jobs: the one-page field copy of a
// job's phases (crew, work days, dumpster loads, all entered by dispatch),
// plus a safety checklist and sign-off. This module lays the phases out on
// workdays, totals them, and draws the PDF sent to Make.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { StateError } from './state.mjs';

export const DEFAULT_PHASES = [
  { name: 'Furniture & Debris Removal', scope: 'Clear all furniture, fixtures, loose debris, and abandoned contents from the floor.', crew: 3, days: 2, loads: 2 },
  { name: 'Drywall Removal', scope: 'Strip gypsum board from walls and ceilings down to the studs and haul it out.', crew: 4, days: 6, loads: 3 },
  { name: 'MEP Removal', scope: 'Pull de-energized electrical, plumbing, and HVAC runs, fixtures, and ductwork.', crew: 4, days: 7, loads: 1 },
  { name: 'Stud Cleaning', scope: 'Remove screws, clips, and remnant board so studs and track are left clean.', crew: 3, days: 5, loads: 1 },
  { name: 'Flooring Removal', scope: 'Take up carpet, tile, VCT, and adhesive down to the slab or subfloor.', crew: 3, days: 7, loads: 1 }
];
export const DEFAULT_SAFETY = [
  'Utilities disconnected and verified dead: electrical locked out, water and gas capped',
  'Hazardous materials survey reviewed; no suspect asbestos or lead left in the work area',
  'PPE on every worker: hard hat, safety glasses, cut-resistant gloves, safety-toe boots',
  'Respirators (N95 minimum) issued for drywall and flooring removal',
  'Dust control set up: poly barriers at openings, misting on, HEPA vac on site',
  'Floor sweeps at end of every shift; walkways, stairs, and exits kept clear',
  'Dumpster placed, swap schedule confirmed with hauler, chute or path protected',
  'Ladders inspected; fire extinguisher and first aid kit on the floor'
];

const num = v => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; };
const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- One phase: crew and days are both set by dispatch ---------- */
export function calcPhase(phase) {
  const crew = clamp(Math.round(num(phase.crew)) || 1, 1, 500);
  const days = clamp(Math.round(num(phase.days)) || 1, 1, 1000);
  const loads = clamp(Math.round(num(phase.loads)), 0, 999);
  return { crew, days, loads, crewDays: crew * days };
}

// Schedules saved before crew-and-days planning worked their numbers out from
// square footage. Recompute those once so an old schedule keeps its dates.
function fromLegacy(raw, p) {
  const sf = num(raw.sf), rate = num(p.rate);
  if (!(sf > 0) || !(rate > 0) || p.plan == null) return p;
  const personDays = sf / rate;
  const out = { ...p };
  if (p.plan === 'days') { out.days = Math.max(1, Math.round(num(p.days)) || 1); out.crew = Math.ceil(personDays / out.days); }
  else { out.crew = Math.max(1, Math.round(num(p.crew)) || 1); out.days = Math.ceil(personDays / out.crew); }
  if (p.loads == null && num(raw.usable) > 0) out.loads = Math.ceil(((sf / 1000) * num(p.yld)) / num(raw.usable)) || 0;
  return out;
}

export const SCHEDULE_MODES = ['seq', 'par', 'custom'];
export const modeLabel = mode => mode === 'par' ? 'Separate crews at once' : mode === 'custom' ? 'Custom (set on the timeline)' : 'One crew, in order';
// seq: one crew, phases back to back. par: every phase starts Day 1.
// custom: each phase starts on its own startDay (set by dragging on the timeline).
export function buildSchedule(input) {
  const mode = SCHEDULE_MODES.includes(input.mode) ? input.mode : 'seq';
  let cursor = 0;
  const rows = (input.phases || []).filter(p => p.on !== false).map(p => {
    const c = calcPhase(p);
    let from = 0, to = 0;
    if (c.days) {
      if (mode === 'par') from = 1;
      else if (mode === 'custom') from = Math.max(1, Math.round(num(p.startDay)) || 1);
      else from = cursor + 1;
      to = from + c.days - 1;
      if (mode === 'seq') cursor = to;
    }
    return { name: p.name, scope: p.scope, ...c, from, to };
  });
  const totalWorkdays = Math.max(0, ...rows.map(r => r.to));
  // Peak crew: the most people on site on any single day.
  let peakCrew = 0;
  for (let d = 1; d <= totalWorkdays; d++) {
    const onSite = rows.reduce((a, r) => a + (r.days && r.from <= d && d <= r.to ? r.crew : 0), 0);
    if (onSite > peakCrew) peakCrew = onSite;
  }
  return {
    rows, mode, totalWorkdays, peakCrew,
    totalLoads: rows.reduce((a, r) => a + r.loads, 0),
    crewDays: rows.reduce((a, r) => a + r.crew * r.days, 0)
  };
}

/* ---------- Mon–Fri workday calendar (UTC, so the server's zone never shifts a date) ---------- */
export function parseYmd(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
export function workday(start, n) {
  const d = new Date(start.getTime());
  const weekend = () => d.getUTCDay() === 0 || d.getUTCDay() === 6;
  while (weekend()) d.setUTCDate(d.getUTCDate() + 1);
  for (let left = n - 1; left > 0;) { d.setUTCDate(d.getUTCDate() + 1); if (!weekend()) left--; }
  return d;
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const ymd = d => d.toISOString().slice(0, 10);
const longDate = d => `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
const shortDate = d => `${DAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;

/* ---------- Validate what the browser sent ---------- */
export function normalizeScheduleInput(raw) {
  if (!raw || typeof raw !== 'object') throw new StateError('Project schedule required');
  const phases = (Array.isArray(raw.phases) ? raw.phases : []).slice(0, 20).map(p => fromLegacy(raw, p || {})).map(p => ({
    name: text(p && p.name, 80) || 'Untitled phase',
    scope: text(p && p.scope, 240),
    crew: clamp(Math.round(num(p && p.crew)) || 1, 1, 500),
    days: clamp(Math.round(num(p && p.days)) || 1, 1, 1000),
    loads: clamp(Math.round(num(p && p.loads)), 0, 999),
    startDay: clamp(Math.round(num(p && p.startDay)) || 1, 1, 2000),
    on: !(p && p.on === false)
  }));
  const safety = (Array.isArray(raw.safety) ? raw.safety : String(raw.safety || '').split('\n'))
    .map(s => text(s, 160)).filter(Boolean).slice(0, 20);
  const start = parseYmd(raw.start) ? String(raw.start) : '';
  return {
    jobId: text(raw.jobId, 80),
    company: text(raw.company, 80) || 'A2Z Construction Services',
    jobName: text(raw.jobName, 150),
    jobAddr: text(raw.jobAddr, 200),
    clientName: text(raw.clientName, 120),
    start,
    mode: SCHEDULE_MODES.includes(raw.mode) ? raw.mode : 'seq',
    phases, safety
  };
}

/* ---------- PDF ---------- */
const ORANGE = rgb(0.91, 0.384, 0.173), INK = rgb(0.082, 0.098, 0.11), MUTED = rgb(0.35, 0.39, 0.42), LINE = rgb(0.75, 0.78, 0.79), VIS = rgb(0.95, 0.72, 0.02), WHITE = rgb(1, 1, 1);
const PAGE_W = 612, PAGE_H = 792, M = 36, W = PAGE_W - 2 * M;

// input: normalized schedule input. options.blank draws an empty form for filling in by hand.
export async function projectSchedulePdf(input, options = {}) {
  const blank = !!options.blank;
  const pdf = await PDFDocument.create();
  pdf.setTitle(blank ? 'Project Schedule (blank)' : `Project Schedule${input.jobName ? ' - ' + input.jobName : ''}`);
  pdf.setAuthor(input.company || 'A2Z Construction Services');
  pdf.setCreator('A2Z Dispatch');
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safeCache = new Map();
  const safe = (s, font) => [...String(s ?? '')].map(ch => {
    const key = ch + (font === bold ? 'b' : 'r');
    if (!safeCache.has(key)) { try { font.encodeText(ch); safeCache.set(key, ch); } catch { safeCache.set(key, '?'); } }
    return safeCache.get(key);
  }).join('');

  let page, y;
  const newPage = () => { page = pdf.addPage([PAGE_W, PAGE_H]); y = PAGE_H - M; };
  const t = (s, x, yy, { size = 9, font = reg, color = INK, align = 'left' } = {}) => {
    const str = safe(s, font);
    const w = font.widthOfTextAtSize(str, size);
    const xx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    page.drawText(str, { x: xx, y: yy, size, font, color });
  };
  const line = (x1, y1, x2, y2, thickness = 0.75, color = INK) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
  const rect = (x, yy, w, h, opts) => page.drawRectangle({ x, y: yy, width: w, height: h, ...opts });
  const wrap = (s, size, maxW, font = reg) => {
    const words = safe(s, font).split(' ').filter(Boolean), out = [];
    let cur = '';
    for (const word of words) {
      const next = cur ? cur + ' ' + word : word;
      if (font.widthOfTextAtSize(next, size) <= maxW || !cur) cur = next; else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
    return out;
  };
  const label = (s, x, yy, opts = {}) => t(String(s).toUpperCase(), x, yy, { size: 6.5, font: bold, color: MUTED, ...opts });
  const ensure = h => { if (y - h < M + 20) { newPage(); } };

  const sched = buildSchedule(input);
  const start = parseYmd(input.start);
  const finish = start && sched.totalWorkdays ? workday(start, sched.totalWorkdays) : null;

  /* Header */
  newPage();
  t(String(input.company || 'A2Z Construction Services').toUpperCase(), M, y - 9, { size: 9, font: bold, color: ORANGE });
  t('PROJECT SCHEDULE', M, y - 34, { size: 24, font: bold });
  t('Interior demolition  |  field copy', M + W, y - 16, { size: 8, color: MUTED, align: 'right' });
  t('Sheet ____ of ____', M + W, y - 30, { size: 8, color: MUTED, align: 'right' });
  y -= 42; line(M, y, M + W, y, 2.5); y -= 10;

  /* Job info grid: 3 columns x 2 rows */
  const cellH = 30, colW = W / 3, ROWS = 2;
  const gridTop = y;
  const cells = [
    { c: 0, r: 0, span: 2, k: 'Job', v: blank ? '' : input.jobName },
    { c: 2, r: 0, span: 1, k: 'Job start date', v: blank ? '' : (start ? longDate(start) : '') },
    { c: 0, r: 1, span: 1, k: 'Site address', v: blank ? '' : input.jobAddr },
    { c: 1, r: 1, span: 1, k: 'Schedule mode', v: blank ? '' : modeLabel(input.mode), mode: blank },
    { c: 2, r: 1, span: 1, k: 'Planned finish', v: blank ? '' : (finish ? longDate(finish) : '') }
  ];
  rect(M, gridTop - cellH * ROWS, W, cellH * ROWS, { borderColor: LINE, borderWidth: 0.75 });
  for (const cell of cells) {
    const x = M + cell.c * colW, top = gridTop - cell.r * cellH, w = colW * cell.span;
    if (cell.c + cell.span < 3) line(x + w, top, x + w, top - cellH, 0.75, LINE);
    if (cell.r < ROWS - 1) line(x, top - cellH, x + w, top - cellH, 0.75, LINE);
    label(cell.k, x + 7, top - 10);
    if (cell.mode) {
      rect(x + 7, top - 25, 7, 7, { borderColor: INK, borderWidth: 0.9 }); t('One crew, in order', x + 18, top - 24.5, { size: 7.5 });
      rect(x + 7 + 90, top - 25, 7, 7, { borderColor: INK, borderWidth: 0.9 }); t('Separate crews', x + 108, top - 24.5, { size: 7.5 });
    } else if (cell.v) {
      const fit = wrap(cell.v, 9.5, w - 14, bold)[0] || '';
      t(fit, x + 7, top - 23, { size: 9.5, font: bold });
    } else {
      line(x + 7, top - 24, x + w - 7, top - 24, 0.6, INK);
      if (cell.unit) t(cell.unit, x + w - 7, top - 22, { size: 7, color: MUTED, align: 'right' });
    }
  }
  y = gridTop - cellH * ROWS - 16;

  /* Phase table */
  const cols = { num: M, name: M + 20, crew: M + W - 208, days: M + W - 160, sched: M + W - 38, loads: M + W };
  const nameW = cols.crew - 30 - cols.name;
  const tableHeader = () => {
    label('#', cols.num, y); label('Phase & scope of work', cols.name, y);
    label('Crew', cols.crew, y, { align: 'right' }); label('Work days', cols.days, y, { align: 'right' });
    label('Schedule', cols.sched, y, { align: 'right' }); label('Loads', cols.loads, y, { align: 'right' });
    y -= 5; line(M, y, M + W, y, 1.5); y -= 3;
  };
  tableHeader();
  const tableRows = blank
    ? [...DEFAULT_PHASES.map(p => ({ name: p.name, scope: p.scope })), { name: '', scope: '' }, { name: '', scope: '' }]
    : sched.rows;
  if (!blank && !tableRows.length) { y -= 16; t('No phases selected.', M + W / 2, y, { size: 9, color: MUTED, align: 'center' }); y -= 10; }
  tableRows.forEach((r, i) => {
    const scopeLines = r.scope ? wrap(r.scope, 7.5, nameW) : [];
    const h = Math.max(blank ? 30 : 24, 14 + scopeLines.length * 9 + 6);
    if (y - h < M + 20) { newPage(); tableHeader(); }
    const top = y;
    t(String(i + 1), cols.num, top - 15, { size: 13, font: bold });
    if (r.name) t(r.name, cols.name, top - 12, { size: 9.5, font: bold });
    else line(cols.name, top - 14, cols.crew - 30, top - 14, 0.5, LINE);
    scopeLines.forEach((sl, j) => t(sl, cols.name, top - 22 - j * 9, { size: 7.5, color: MUTED }));
    if (blank) {
      [[cols.crew, 26], [cols.days, 30], [cols.sched, 84], [cols.loads, 26]].forEach(([x, w]) => line(x - w, top - 15, x, top - 15, 0.6, INK));
      t('Day', cols.sched - 84, top - 13, { size: 7, color: MUTED });
    } else {
      t(String(r.crew), cols.crew, top - 12, { size: 9.5 });
      t(String(r.days), cols.days, top - 12, { size: 9.5 });
      const range = r.days ? (r.from === r.to ? `Day ${r.from}` : `Day ${r.from}–${r.to}`) : '—';
      t(range, cols.sched, top - 12, { size: 9.5, align: 'right' });
      if (start && r.days) {
        const a = workday(start, r.from), b = workday(start, r.to);
        t(r.from === r.to ? shortDate(a) : `${shortDate(a)} – ${shortDate(b)}`, cols.sched, top - 21, { size: 6.8, color: MUTED, align: 'right' });
      }
      t(String(r.loads), cols.loads, top - 12, { size: 9.5, align: 'right' });
    }
    y = top - h; line(M, y, M + W, y, 0.6, LINE);
  });
  y -= 12;

  /* Totals bar */
  ensure(44);
  const barH = 38;
  rect(M, y - barH, W, barH, { color: INK });
  const totals = [
    ['Total workdays', sched.totalWorkdays], ['Dumpster loads', sched.totalLoads],
    ['Crew-days of labor', sched.crewDays], ['Peak crew on one day', sched.peakCrew]
  ];
  totals.forEach(([k, v], i) => {
    const x = M + (W / 4) * i;
    if (i) line(x, y - 6, x, y - barH + 6, 0.5, rgb(0.4, 0.42, 0.44));
    if (blank) line(x + 9, y - 21, x + 60, y - 21, 0.8, WHITE);
    else t(String(v), x + 9, y - 21, { size: 18, font: bold, color: WHITE });
    t(k.toUpperCase(), x + 9, y - 32, { size: 6.5, font: bold, color: rgb(0.8, 0.82, 0.83) });
  });
  y -= barH + 18;

  /* Safety (left) and sign-off (right) */
  const safety = input.safety && input.safety.length ? input.safety : DEFAULT_SAFETY;
  const leftW = W * 0.56, gap = 18, rightX = M + leftW + gap, rightW = W - leftW - gap;
  const itemLines = safety.map(s => wrap(s, 8, leftW - 60));
  const safetyH = 30 + itemLines.reduce((a, l) => a + l.length * 10 + 8, 0);
  ensure(Math.max(safetyH, 190));
  const lowerTop = y;

  t('SAFETY & PPE', M, y - 10, { size: 11, font: bold });
  // Hazard stripe
  const stripeX = M + bold.widthOfTextAtSize('SAFETY & PPE', 11) + 8, stripeW = M + leftW - stripeX, stripeY = y - 9;
  for (let x = stripeX, k = 0; x < stripeX + stripeW; x += 6, k++) rect(x, stripeY, Math.min(6, stripeX + stripeW - x), 6, { color: k % 2 ? INK : VIS });
  y -= 24;
  label('Superintendent check before work starts', M + 18, y); label('Init.', M + leftW, y, { align: 'right' });
  y -= 4; line(M, y, M + leftW, y, 0.9);
  itemLines.forEach(lines => {
    const top = y - 4;
    rect(M, top - 9, 8, 8, { borderColor: INK, borderWidth: 1 });
    lines.forEach((l, j) => t(l, M + 18, top - 8 - j * 10, { size: 8 }));
    line(M + leftW - 34, top - 9, M + leftW, top - 9, 0.6);
    y = top - lines.length * 10 - 4;
    line(M, y, M + leftW, y, 0.5, LINE);
  });
  const leftBottom = y;

  y = lowerTop;
  t('SIGN-OFF', rightX, y - 10, { size: 11, font: bold });
  y -= 30;
  const sig = role => {
    label(role, rightX, y);
    y -= 22;
    const w1 = (rightW - 50 - 12) / 2;
    [[rightX, w1, 'Print name'], [rightX + w1 + 6, w1, 'Signature'], [rightX + 2 * w1 + 12, 50, 'Date']].forEach(([x, w, cap]) => {
      line(x, y, x + w, y, 0.7);
      t(cap, x, y - 8, { size: 6.5, color: MUTED });
    });
    y -= 24;
  };
  sig('Foreman'); sig('Superintendent');
  rect(rightX, y - 40, rightW, 40, { borderColor: INK, borderWidth: 1.2 });
  label('Actual completion date', rightX + 8, y - 11);
  line(rightX + 8, y - 30, rightX + rightW - 8, y - 30, 0.7);
  y = Math.min(leftBottom, y - 40) - 14;

  /* Footer */
  if (y < M + 14) { newPage(); }
  line(M, y, M + W, y, 0.5, LINE);
  t('Crew-days = crew x work days. Workdays run Mon-Fri; the schedule skips weekends.', M, y - 10, { size: 6.8, color: MUTED });
  if (!blank) t(`Issued ${options.issuedOn || ymd(new Date())}`, M + W, y - 10, { size: 6.8, color: MUTED, align: 'right' });

  return pdf.save();
}

/* ---------- Send to Make ---------- */
// Posts the PDF to Make as multipart/form-data: binary in "file", plus flat fields.
export const PROJECT_SCHEDULE_WEBHOOK = 'https://hook.us2.make.com/ym8j30bvydhops1cbq53y4yjypzx7z8k';
export async function sendProjectSchedule(input, { fetchImpl = fetch, url = process.env.PROJECT_SCHEDULE_WEBHOOK || PROJECT_SCHEDULE_WEBHOOK } = {}) {
  const schedule = buildSchedule(input);
  const start = parseYmd(input.start);
  const plannedFinish = start && schedule.totalWorkdays ? ymd(workday(start, schedule.totalWorkdays)) : '';
  const submittedAt = new Date().toISOString();
  const pdf = await projectSchedulePdf(input, { issuedOn: submittedAt.slice(0, 10) });
  const fileName = scheduleFileName(input);
  const summary = {
    action: 'project_schedule', jobId: input.jobId, opportunityId: input.jobId,
    jobName: input.jobName, jobAddress: input.jobAddr, clientName: input.clientName,
    startDate: input.start, plannedFinish,
    scheduleMode: modeLabel(input.mode),
    totalWorkdays: schedule.totalWorkdays, totalLoads: schedule.totalLoads,
    crewDays: schedule.crewDays, peakCrew: schedule.peakCrew, submittedAt, fileName
  };
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), fileName);
  for (const [k, v] of Object.entries(summary)) form.append(k, String(v ?? ''));
  form.append('phases', JSON.stringify(schedule.rows.map(r => ({
    name: r.name, scope: r.scope, crew: r.crew, workDays: r.days, fromDay: r.from, toDay: r.to, loads: r.loads,
    crewDays: r.crewDays
  }))));
  form.append('safety', JSON.stringify(input.safety));
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', body: form, signal: AbortSignal.timeout(25000),
      headers: process.env.MAKE_API_KEY ? { 'x-make-apikey': process.env.MAKE_API_KEY } : {}
    });
  } catch {
    throw new StateError('Saved, but Make did not answer. Check the Project Schedule scenario history before resending.', 502);
  }
  const body = await response.text();
  if (!response.ok) throw new StateError(`Saved, but Make refused the PDF (HTTP ${response.status}).`, 502);
  // A plain "Accepted" is success. If the scenario answers JSON, respect an explicit ok:false.
  let parsed = null; try { parsed = JSON.parse(body); } catch { /* not JSON */ }
  if (parsed && parsed.ok === false) throw new StateError(`Saved, but Make reported: ${parsed.error || 'a problem with the PDF'}.`, 502);
  return { fileName, plannedFinish };
}

export function scheduleFileName(input) {
  const name = String(input.jobName || 'Job').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 90) || 'Job';
  return `Project Schedule - ${name}.pdf`;
}

/* ---------- Shared storage (project_schedules table) ---------- */
const toRecord = row => row && (() => { const input = normalizeScheduleInput(row.data || {}); return {
  jobId: row.job_id, input, version: row.version,
  sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : '', sentFile: row.sent_file || '',
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : '',
  schedule: buildSchedule(input)
}; })();
export async function listProjectSchedules(sql) {
  return (await sql`select * from project_schedules order by updated_at desc limit 500`).map(toRecord);
}
export async function getProjectSchedule(sql, jobId) {
  const [row] = await sql`select * from project_schedules where job_id = ${jobId}`;
  return toRecord(row) || null;
}
// expectedVersion: the version the editor opened (0 = new). A mismatch means
// someone else saved in between, so the caller reloads instead of overwriting.
export async function saveProjectSchedule(sql, input, expectedVersion) {
  return sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${'project_schedule:' + input.jobId}, 0))`;
    const [current] = await tx`select version from project_schedules where job_id = ${input.jobId}`;
    const have = current ? current.version : 0;
    if (expectedVersion != null && Number(expectedVersion) !== have) {
      throw new StateError('Someone else saved this Project Schedule. Close it and reopen to get their changes.', 409);
    }
    const [row] = current
      ? await tx`update project_schedules set data = ${tx.json(input)}, version = version + 1, updated_at = now() where job_id = ${input.jobId} returning *`
      : await tx`insert into project_schedules (job_id, data) values (${input.jobId}, ${tx.json(input)}) returning *`;
    return toRecord(row);
  });
}
export async function markProjectScheduleSent(sql, jobId, fileName) {
  const [row] = await sql`update project_schedules set sent_at = now(), sent_file = ${fileName} where job_id = ${jobId} returning *`;
  return toRecord(row);
}
