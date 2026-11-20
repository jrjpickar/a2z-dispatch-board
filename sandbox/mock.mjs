// In-memory transport for the standalone dashboard. No calls leave the page.
const NativeDate = Date;
const today = dispatch.pacificParts().date;
const tomorrow = dispatch.addDays(today, 1);
let now = sms.pacificToUtc(today, '08:00');
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};

const jobs = [], records = new Map(), held = [], notes = new Map(), messages = new Map(), payloads = [], activities = [];
const roster = ['Ana Lopez', 'Ana Diaz', 'Juan Lopez', 'Marta Cruz', 'Luis Rivera', 'Rosa Vega', 'Diego Flores', 'Elena Ramos', 'Noe Marin']
  .map((name, i) => ({ id: 'worker-' + i, name, phone: '+1202555010' + i, status: 'available' }));
const makeTimes = (date, start, end, customTime = false) => ({
  reportDate: date, reportTime: start, reportEndDate: end < start ? dispatch.addDays(date, 1) : date, reportEndTime: end, customTime
});
function addJob(id, address, date, start, end, { ghl = false, night = false } = {}) {
  const times = makeTimes(date, start, end);
  const customFields = ghl ? [
    { id: 'rY3IebKlcBhAjWlaSSQm', fieldValueString: date },
    { id: 'WtpFGtiB7hgmTGTsHJAW', fieldValueString: start }
  ] : [];
  jobs.push({ id, name: address, clientName: 'Sandbox client', contact: { name: 'Sandbox client' }, sourceType: 'labor', customFields });
  records.set(id, { version: 1, active: true, data: { jobAddress: address, crew: [], nightWork: night, ...(!ghl ? times : {}) } });
  return times;
}
function record(id) { const r = records.get(id); return r && { jobId: id, version: r.version, active: r.active, ...r.data }; }
const allRecords = () => [...records.keys()].map(record);
function logWorker(action, job, worker, due, note = '') {
  activities.unshift({ actor: 'Sandbox dispatcher', at: new Date().toISOString(),
    ...activity.scheduleActivity(action, job, worker, sms.effectiveWorkerTimes(job, worker), due == null ? '' : dispatch.pacificIso(due), note) });
}
function commit(input) {
  const previous = records.get(input.jobId);
  const next = state.mutateJob(previous, input);
  records.set(input.jobId, { ...next, version: (previous?.version || 0) + 1 });
  const job = record(input.jobId);
  if (input.action === 'assign' || input.action === 'save_times') {
    const workers = input.action === 'assign' ? input.crewChanges.map(w => sms.matchWorker(job.crew, w)).filter(Boolean) : job.crew;
    const action = input.action === 'save_times' ? 'Changed times' : input.splitDayFrom ? 'Assigned split day' : 'Assigned';
    for (const w of workers) logWorker(action, job, w, dispatch.rowDueAt(job, { payload: w }), w.dontText ? "Don't text" : '');
  }
  const removed = input.action === 'remove' && (input.removedWorkers || []);
  if (removed) for (const w of removed) {
    const old = sms.matchWorker(previous.data.crew, w);
    if (old) messages.delete(messageKey(job.jobId, job.reportDate, old.phone));
  }
  return { ok: true, record: job, requestId: input.requestId };
}
function makeAssign(id, worker) {
  const j = record(id);
  return dispatch.refreshAssign({ action: 'assign', jobId: id, jobAddress: j.jobAddress, contactId: worker.id,
    workerName: worker.name, workerPhone: worker.phone, workerIndex: 1, workerCount: 1,
    ...(worker.textAtMode ? { textAt: worker.textAt, textAtMode: worker.textAtMode } : {}) }, j);
}
function notify(id, date, worker) {
  if (!notes.has(id)) notes.set(id, []);
  const list = notes.get(id);
  if (!list.some(r => r.report_date === date && dispatch.ledgerMatch(r, worker))) {
    list.push({ report_date: date, worker_key: dispatch.workerKey(worker), contact_id: worker.contactId || worker.id,
      worker_name: worker.workerName || worker.name, worker_phone: worker.workerPhone || worker.phone });
  }
}
function transmit(kind, body) {
  payloads.unshift({ kind, body, at: now });
  if (body.action === 'remove') {
    const rows = notes.get(body.jobId) || [];
    notes.set(body.jobId, rows.filter(r => !dispatch.rowWorkers(body).some(w => dispatch.ledgerMatch(r, w))));
  } else if (['assign', 'rapid_assign', 'split_day_assign'].includes(body.action)) {
    const worker = dispatch.rowWorkers(body)[0];
    notify(body.jobId, record(body.jobId)?.reportDate, worker);
    if (body.jobId2) notify(body.jobId2, record(body.jobId2)?.reportDate, worker);
  }
}
const messageKey = (id, date, phone) => [id, date, sms.toE164(phone)].join('|');
function textJob(id, listed = [], resend = false) {
  const job = record(id);
  const rendered = sms.buildCrewSchedule(jobs, allRecords(), job.reportDate).jobs.find(j => j.jobId === id);
  let sent = 0;
  for (const recipient of rendered?.crew || []) {
    const worker = sms.matchWorker(job.crew, recipient);
    if (worker?.dontText || !recipient.phone || rendered.crew.some(x => x !== recipient && x.phone === recipient.phone)) continue;
    if (listed.length && !listed.some(w => sms.matchWorker(rendered.crew, w) === recipient)) continue;
    if (!dispatch.workerLedger((notes.get(id) || []).filter(r => r.report_date === job.reportDate), worker, job.crew)) continue;
    const key = messageKey(id, job.reportDate, recipient.phone);
    if (messages.has(key) && !resend) continue;
    messages.set(key, { at: now, text: recipient.text });
    sent++;
  }
  return sent;
}
function dueRows(id) { return held.filter(r => r.payload.jobId === id); }
function planned(id, worker) {
  const job = record(id);
  if (worker.dontText) return null;
  const row = [...held].reverse().find(r => ['assign', 'split_day_assign'].includes(r.payload.action) &&
    (r.payload.jobId === id || r.payload.jobId2 === id) && sms.matchWorker(job.crew, r.payload) === worker);
  if (row) return dispatch.rowDueAt(record(row.payload.jobId), row);
  return dispatch.rowDueAt(job, { payload: worker });
}
function settle(id, force = false, removesOnly = false) {
  const job = record(id);
  const rows = dueRows(id);
  const ledger = notes.get(id) || [];
  const { send, drop } = dispatch.decide(rows, { crew: job.crew, date: job.reportDate, today: dispatch.pacificParts(now).date, ledger,
    mode: removesOnly ? 'removes' : 'due', eligible: r => force || (dispatch.rowDueAt(job, r) ?? Infinity) <= now });
  const ids = new Set([...drop, ...send.map(x => x.row.effect_id)]);
  for (let i = held.length - 1; i >= 0; i--) if (ids.has(held[i].effect_id)) held.splice(i, 1);
  const secondary = new Set();
  for (const r of send) {
    let body = dispatch.refreshAssign(r.payload, job);
    if (force && body.textAtMode) body = { ...body, textAtMode: 'now', textAt: dispatch.pacificIso(now) };
    transmit(r.row.kind, body);
    if (body.jobId2) secondary.add(body.jobId2);
  }
  let makeSent = send.length;
  if (!removesOnly) for (const w of job.crew) {
    if (w.dontText || dispatch.workerLedger((notes.get(id) || []).filter(r => r.report_date === job.reportDate), w, job.crew)) continue;
    const due = planned(id, w);
    if ((force || dispatch.carriedOver(ledger, w, job.reportDate, job.crew)) && (force || (due ?? Infinity) <= now)) {
      transmit('workers', makeAssign(id, w));
      makeSent++;
    }
  }
  const texted = removesOnly ? 0 : textJob(id) + [...secondary].reduce((n, other) => n + textJob(other), 0);
  if (force) for (const w of job.crew) logWorker('Sent schedule now', job, w, now, w.dontText ? "Don't text" : '');
  return { ok: true, makeSent, texted };
}
function runDue() {
  for (const job of allRecords()) settle(job.jobId);
  redraw();
}
function queue(kind, payload) {
  if (kind === 'crew_text') return { ok: true, texted: payload.rapidAssign ? textJob(payload.jobId, payload.textWorkers) : 0 };
  if (dispatch.waitsForHold(kind, payload)) {
    const job = record(payload.jobId);
    const plan = payload.textAtMode ? dispatch.textPlan(job, payload) : {};
    const row = { effect_id: 'sandbox-' + (++seq), kind, payload, send_at: plan.textAt };
    held.push(row);
    const due = dispatch.rowDueAt(job, row);
    const result = settle(payload.jobId, false, due == null || due > now);
    return { ...result, held: held.includes(row), dueAt: due == null ? '' : new Date(due).toISOString() };
  }
  transmit(kind, payload);
  if (kind === 'split_day' && payload.jobId2) textJob(payload.jobId2);
  return { ok: true };
}
let seq = 0;
const ghlTimes = addJob('ghl', '123 Main St', today, '12:00', '16:00', { ghl: true });
addJob('moved', '280 Juniper Ave', today, '09:00', '17:00');
const movedTimes = makeTimes(tomorrow, '09:00', '17:00');
const splitTimes = addJob('split', '46 Harbor Blvd', tomorrow, '08:00', '16:00');
const secondTimes = addJob('second', '600 Bayview Rd', tomorrow, '12:00', '16:00');
const nightTimes = addJob('night', '900 Pacific Coast Hwy', today, '22:00', '06:00', { night: true });

function seed(id, w, times, plan = {}, dontText = false) {
  commit({ action: 'assign', jobId: id, ...times, crewChanges: [{ ...w, ...plan, dontText, workerTimes: times }] });
  return record(id).crew.find(x => x.id === w.id);
}
const ghlWorker = seed('ghl', roster[0], ghlTimes);
queue('workers', makeAssign('ghl', ghlWorker));
const movedWorker = seed('moved', roster[1], { ...movedTimes, reportDate: today, reportEndDate: today });
notify('moved', today, movedWorker);
commit({ action: 'save_times', jobId: 'moved', ...movedTimes });
const anaTimes = makeTimes(tomorrow, '07:00', '11:30', true);
const otherTimes = makeTimes(tomorrow, '12:30', '16:00', true);
const chosen = { textAtMode: 'custom', textAt: dispatch.pacificIso(sms.pacificToUtc(today, '14:15')) };
const splitWorker = seed('split', roster[2], anaTimes, chosen);
seed('second', roster[2], otherTimes, chosen);
const splitBody = { ...makeAssign('split', splitWorker), action: 'split_day_assign', splitDay: true, jobId1: 'split', jobId2: 'second', jobAddress2: record('second').jobAddress };
for (const [index, t] of [[1, anaTimes], [2, otherTimes]]) {
  const j = record(index === 1 ? 'split' : 'second');
  for (const key of ['reportDate', 'reportTime', 'reportEndDate', 'reportEndTime']) {
    splitBody[key + index] = j[key];
    splitBody['worker' + key[0].toUpperCase() + key.slice(1) + index] = t[key];
  }
  splitBody['customTime' + index] = t.customTime;
}
queue('split_day', splitBody);
const customWorker = seed('split', roster[3], makeTimes(tomorrow, '09:15', '14:45', true));
queue('workers', makeAssign('split', customWorker));
seed('night', roster[4], nightTimes, {}, true);
const nightWorker = seed('night', roster[5], nightTimes);
queue('workers', makeAssign('night', nightWorker));

function waiting() {
  const entries = {};
  for (const job of allRecords()) {
    const workers = dueRows(job.jobId).filter(r => r.payload.action !== 'remove').map(r => {
      const p = r.payload;
      const due = dispatch.rowDueAt(job, r);
      return { name: p.workerName, key: dispatch.workerKey(p), dueAt: due == null ? '' : new Date(due).toISOString() };
    });
    if (workers.length) entries[job.jobId] = { workers, changes: workers.length, names: workers.map(w => w.name), dueAt: workers.map(w => w.dueAt).filter(Boolean).sort()[0] };
  }
  return { jobs: entries, holdHours: dispatch.holdHours() };
}
function textRows() {
  return [today, tomorrow].flatMap(date => sms.buildCrewSchedule(jobs, allRecords(), date).jobs.flatMap(j => {
    const job = record(j.jobId);
    return j.crew.map(r => {
      const w = sms.matchWorker(job.crew, r);
      const sent = messages.get(messageKey(j.jobId, date, r.phone));
      const due = planned(j.jobId, w);
      return { job, worker: r, sent, due, status: w.dontText ? "Don't text" : sent ? 'Sent' : due == null ? 'Unscheduled' : 'Waiting' };
    });
  }));
}
function api(url, method, body) {
  const route = url.pathname;
  if (route === '/api/dashboard-data') return { jobs, sharedState: allRecords() };
  if (route === '/api/roster') return url.searchParams.get('kind') === 'labor' ? roster : [];
  if (route === '/api/session') return { signedIn: true, user: { id: 'sandbox', name: 'Sandbox dispatcher', email: 'sandbox@example.test' }, isSenior: true };
  if (route === '/api/shared-state') return method === 'POST' ? commit(body) : { sharedState: allRecords(), pendingSync: [] };
  if (route === '/api/workflow-effect') {
    if (method === 'GET') {
      if (url.searchParams.get('waiting')) return waiting();
      const id = url.searchParams.get('notified');
      return id ? { workers: notes.get(id) || [] } : { issues: [] };
    }
    if (body.op === 'job_send_now') return settle(body.jobId, true);
    // Text crew dropdown: one worker, texted even with Don't text or a text already sent.
    if (body.op === 'worker_text_now') {
      const job = record(body.jobId);
      if (!job?.reportDate) return { ok: false, error: 'This job has no date. Save its times first.' };
      const w = sms.matchWorker(job.crew, body.worker || {});
      if (!w) return { ok: false, error: 'That worker is not on this job anymore. Refresh the board.' };
      const rendered = sms.buildCrewSchedule(jobs, allRecords(), job.reportDate).jobs.find(j => j.jobId === body.jobId);
      const r = rendered?.crew.find(x => sms.matchWorker(job.crew, x) === w);
      if (!r?.phone) return { ok: false, error: `${w.name} has no phone number.` };
      // Like Send now did: the worker's waiting run (or a fresh rapid_assign) goes to the worker webhook too.
      const waitingRow = dueRows(body.jobId).filter(x => x.payload.action !== 'remove' && sms.matchWorker(job.crew, x.payload) === w).at(-1);
      if (waitingRow) {
        held.splice(held.indexOf(waitingRow), 1);
        let p = dispatch.refreshAssign(waitingRow.payload, job);
        if (p.textAtMode) p = { ...p, textAtMode: 'now', textAt: dispatch.pacificIso(now) };
        transmit(waitingRow.kind, { ...p, sentFrom: 'worker_text_now' });
      }
      else transmit('workers', { ...makeAssign(body.jobId, w), action: 'rapid_assign', rapidAssign: true, sentFrom: 'worker_text_now' });
      messages.set(messageKey(body.jobId, job.reportDate, r.phone), { at: now, text: r.text });
      transmit('crew_text', { action: 'crewText', jobId: body.jobId, jobAddress: job.jobAddress, reportDate: job.reportDate, triggeredBy: 'worker_text_now', manual: true,
        textWorkers: [{ contactId: w.id || '', workerName: w.name, workerPhone: r.phone }], text: r.text });
      logWorker('Sent schedule text', job, w, now);
      return { ok: true, worker: w.name, date: job.reportDate };
    }
    if (body.op === 'times_changed') {
      const job = record(body.jobId);
      if (!body.resend) return { ok: true, texted: 0 };
      const workers = job.crew.filter(w => !w.dontText && dispatch.workerLedger(notes.get(body.jobId) || [], w, job.crew));
      for (const w of workers) {
        const p = makeAssign(body.jobId, w);
        transmit('workers', { ...p, timesChanged: true, previousReportDate: body.previous?.reportDate || '',
          previousReportTime: body.previous?.reportTime || '', previousReportEndDate: body.previous?.reportEndDate || '',
          previousReportEndTime: body.previous?.reportEndTime || '' });
        logWorker('Resent schedule', job, w, now);
      }
      return { ok: true, makeSent: workers.length, texted: textJob(body.jobId, workers, true) };
    }
    if (body.op) return { ok: true };
    return queue(body.kind, body.payload);
  }
  if (route === '/api/senior' && url.searchParams.get('view') === 'activity') return { activity: activities };
  if (route === '/api/senior' && url.searchParams.get('view') === 'texts') {
    const rows = textRows();
    return { today, summary: { workers: rows.length, sent: rows.filter(r => r.sent).length, pending: rows.filter(r => r.status === 'Waiting').length },
      jobs: allRecords().map(job => ({ jobId: job.jobId, name: job.jobAddress, date: job.reportDate, workers: rows.filter(r => r.job.jobId === job.jobId).map(r => ({
        key: dispatch.workerKey(r.worker), name: r.worker.name, phone: r.worker.phone, workerTimes: r.worker.workerTimes,
        status: r.status === 'Waiting' ? 'pending' : r.sent ? 'sent' : 'dont_text', label: r.status,
        at: r.sent ? new Date(r.sent.at).toISOString() : r.due == null ? '' : new Date(r.due).toISOString()
      })) })) };
  }
  if (route === '/api/logistics-data') return { moves: [] };
  if (route === '/api/field-clock') return { shifts: [] };
  return {};
}
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), 'https://sandbox.invalid');
  if (url.origin !== 'https://sandbox.invalid') return Response.json({ error: 'Network disabled in this sandbox.' }, { status: 403 });
  try {
    const result = api(url, init.method || 'GET', init.body ? JSON.parse(init.body) : {});
    if (document.getElementById('scheduleSandbox') && init.method === 'POST') redraw();
    return Response.json(result);
  } catch (error) { return Response.json({ error: error.message }, { status: error.status || 400 }); }
};

const format = value => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(value) + ' PT';
function box(parent, element, text) {
  const node = document.createElement(element);
  if (text) node.textContent = text;
  parent.append(node);
  return node;
}
function redraw() {
  document.getElementById('sandbox-clock').textContent = format(now);
  const texts = document.getElementById('sandbox-texts'); texts.replaceChildren();
  for (const r of textRows()) {
    const item = box(texts, 'article');
    box(item, 'h4', r.worker.name + ' | ' + r.job.jobAddress);
    box(item, 'p', [r.worker.phone, r.status, r.sent ? 'Sent ' + format(r.sent.at) : r.status === 'Waiting' && r.due != null ? 'Planned ' + format(r.due) : ''].filter(Boolean).join(' · '));
    if (r.status !== "Don't text") box(item, 'pre', r.sent?.text || r.worker.text);
  }
  const runs = document.getElementById('sandbox-payloads'); runs.replaceChildren();
  for (const p of payloads) {
    const d = box(runs, 'details'); d.open = true;
    box(d, 'summary', p.kind + ' · ' + p.body.action + ' · ' + format(p.at));
    box(d, 'pre', JSON.stringify(p.body, null, 2));
  }
  const log = document.getElementById('sandbox-activity'); log.replaceChildren();
  for (const a of activities) box(log, 'li', a.action + ' ' + a.target);
}
document.addEventListener('DOMContentLoaded', () => {
  const section = document.createElement('section');
  section.id = 'scheduleSandbox';
  section.innerHTML = `
    <style>
      #scheduleSandbox {max-width:1280px;margin:24px auto;padding:22px;color:#182537;background:#f2f5fa;border:1px solid #ccd6e6;border-radius:12px;font:14px system-ui}
      #scheduleSandbox h2,#scheduleSandbox h3 {margin:0 0 10px}
      #scheduleSandbox button {margin:0 8px 10px 0;padding:8px;border:1px solid #95a7bf;border-radius:6px;background:white;color:#182537;cursor:pointer}
      #scheduleSandbox .sandbox-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:16px}
      #scheduleSandbox .sandbox-card {background:white;border:1px solid #ccd6e6;border-radius:8px;padding:14px;min-width:0}
      #scheduleSandbox .sandbox-list {max-height:480px;overflow:auto}
      #scheduleSandbox article,#scheduleSandbox details {margin-bottom:10px;padding:10px;border:1px solid #dce4ee;border-radius:6px}
      #scheduleSandbox h4,#scheduleSandbox p {margin:0 0 6px}
      #scheduleSandbox pre {white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;font:12px/1.35 monospace}
      #sandbox-activity {padding-left:20px} #sandbox-activity li {margin:6px 0}
    </style>
    <h2>Schedule text sandbox</h2>
    <p>Pacific clock <strong id="sandbox-clock"></strong> · Simulated Make and Twilio</p>
    <button type="button" id="sandbox-jump">Jump to next send</button><button type="button" id="sandbox-run">Run due now</button>
    <div class="sandbox-grid">
      <section class="sandbox-card"><h3>Schedule texts</h3><div class="sandbox-list" id="sandbox-texts"></div></section>
      <section class="sandbox-card"><h3>Payloads</h3><div class="sandbox-list" id="sandbox-payloads"></div></section>
      <section class="sandbox-card"><h3>Activity log</h3><ul class="sandbox-list" id="sandbox-activity"></ul></section>
    </div>`;
  document.body.prepend(section);
  section.querySelector('#sandbox-jump').onclick = () => {
    const due = textRows().map(r => r.status === 'Waiting' ? r.due : null).filter(t => t != null && t > now);
    if (due.length) now = Math.min(...due);
    runDue();
  };
  section.querySelector('#sandbox-run').onclick = runDue;
  redraw();
});
