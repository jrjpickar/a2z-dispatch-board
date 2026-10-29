// Completed job log, read back from Make for the EOD Done > Job log view.
// The board POSTs { action: "read", from, to } to JOB_LOG_READ_WEBHOOK. Make searches
// the job log sheet and answers with JSON: an array of rows, or { rows: [...] }.
// Column names are matched loosely ("Job ID", "jobId", "job_id" all work).
const ALIASES = {
  jobId: ['jobid', 'id', 'opportunityid'],
  action: ['action', 'type', 'logtype'],
  date: ['date', 'workdate', 'eoddate', 'day'],
  loggedAt: ['loggedat', 'timestamp', 'createdat', 'submittedat', 'sentat'],
  jobAddress: ['jobaddress', 'address', 'jobname', 'job'],
  clientName: ['clientname', 'client'],
  clientPhone: ['clientphone', 'phone'],
  scopeOfWork: ['scopeofwork', 'scope'],
  monetaryValue: ['monetaryvalue', 'value', 'jobvalue'],
  hoursWorked: ['hoursworked', 'hours', 'totalhours', 'totalcrewhours'],
  reportDate: ['reportdate', 'startdate'],
  reportTime: ['reporttime', 'starttime'],
  reportEndTime: ['reportendtime', 'endtime'],
  assignedWorkers: ['assignedworkers', 'workers', 'crew', 'employees'],
  submittedBy: ['submittedby', 'sentby', 'by'],
  rowId: ['rowid', 'rownumber', 'row', 'eventid'],
  pdfUrl: ['pdfurl', 'pdflink', 'pdf', 'fileurl', 'sheeturl'],
  contactName: ['contactname', 'contact'],
  toolsRequired: ['toolsrequired', 'tools']
};
const key = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const num = v => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
export function toIsoDay(v) {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return '';
}
function workers(v) {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) { try { return workers(JSON.parse(t)); } catch { /* plain text */ } }
    return t ? t.split(/\s*[,;\n]\s*/).filter(Boolean).map(name => ({ name, hours: null, sentHome: false })) : [];
  }
  if (!Array.isArray(v)) return [];
  return v.map(w => typeof w === 'string' ? { name: w, hours: null, sentHome: false } : {
    name: String(w?.workerName ?? w?.name ?? '').trim(),
    hours: w?.hoursWorked ?? w?.hours ?? null,
    sentHome: w?.sentHome === true || w?.sentHome === 'true'
  }).filter(w => w.name).map(w => ({ ...w, hours: w.hours === null || w.hours === '' ? null : num(w.hours) }));
}
export function normalizeJobLogRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const flat = {};
  for (const [k, v] of Object.entries(raw)) flat[key(k)] = v;
  const get = name => { for (const a of [key(name), ...ALIASES[name]]) if (flat[a] !== undefined && flat[a] !== null && flat[a] !== '') return flat[a]; return ''; };
  const action = String(get('action')).toLowerCase();
  const row = {
    jobId: String(get('jobId')),
    action: /complete/.test(action) ? 'complete' : /eod/.test(action) ? 'eod_sheet' : action,
    date: toIsoDay(get('date')) || toIsoDay(get('reportDate')) || toIsoDay(get('loggedAt')),
    loggedAt: String(get('loggedAt')),
    jobAddress: String(get('jobAddress')),
    clientName: String(get('clientName')),
    clientPhone: String(get('clientPhone')),
    scopeOfWork: String(get('scopeOfWork')),
    monetaryValue: num(get('monetaryValue')),
    hoursWorked: num(get('hoursWorked')),
    reportTime: String(get('reportTime')),
    reportEndTime: String(get('reportEndTime')),
    workers: workers(get('assignedWorkers')),
    submittedBy: String(get('submittedBy')),
    rowId: String(get('rowId')),
    contactName: String(get('contactName')),
    toolsRequired: String(get('toolsRequired')),
    pdfUrl: /^https:\/\//i.test(String(get('pdfUrl'))) ? String(get('pdfUrl')) : ''
  };
  return row.jobId || row.jobAddress ? row : null;
}
export function normalizeJobLog(body, from, to) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : Array.isArray(body?.data) ? body.data : null;
  if (!list) throw new Error('Job log source must return a JSON array or { "rows": [...] }');
  return list.map(normalizeJobLogRow).filter(r => r && (!r.date || ((!from || r.date >= from) && (!to || r.date <= to)))).slice(0, 3000);
}

// Rows Make pushes in: an array, { rows: [...] }, or one row object.
export function pushedRows(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : Array.isArray(body?.data) ? body.data : body && typeof body === 'object' ? [body] : null;
  if (!list) throw new Error('Send a JSON row, an array of rows, or { "rows": [...] }');
  return list.map(normalizeJobLogRow).filter(Boolean);
}
// Same row sent twice (Make retry, re-run) updates instead of duplicating.
export const jobLogRowKey = r => r.rowId ? `row:${r.rowId}` : [r.jobId || r.jobAddress, r.action, r.date, r.loggedAt].join('|');
// A PDF attaches to a row by eventId/rowId when Make sends one, otherwise by jobId + action + date.
export const pdfMatchKey = ({ eventId, jobId, action, date }) => eventId ? `event:${eventId}` : `job:${jobId}|${action || 'eod_sheet'}|${date}`;
// The id a row's PDF and its Daily Job Log document are filed under.
export const rowDocId = r => r.rowId ? `event:${r.rowId}` : `job:${r.jobId || r.jobAddress}|${r.action === 'complete' ? 'complete' : 'eod_sheet'}|${r.date}`;
export const isDocId = v => /^(event:[^\s|]{1,120}|job:[^\s|]{1,120}\|(eod_sheet|complete)\|\d{4}-\d{2}-\d{2})$/.test(String(v || ''));
export function attachPdfs(rows, pdfs, docs = []) {
  const byKey = new Map(pdfs.map(p => [p.match_key, p.id]));
  const docBy = new Map(docs.map(d => [d.doc_id, d]));
  return rows.map(r => {
    const docId = rowDocId(r);
    const find = suffix => (r.rowId && byKey.get(`event:${r.rowId}${suffix}`)) || byKey.get(`job:${r.jobId}|${r.action}|${r.date}${suffix}`);
    const id = find(''), docxId = find('#docx');
    const doc = docBy.get(docId);
    return { ...r, docId, ...(id ? { pdfId: id } : {}), ...(docxId ? { docxId } : {}), ...(doc ? { docEdited: true, docGeneratedAt: doc.generated_at || null } : {}) };
  });
}
