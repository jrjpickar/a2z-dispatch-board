// Daily Job Log document (jobLogTemplateForAccountingV4.docx), edited on the board in
// EOD Done > Completed job log, then sent to Make (job_log_pdf) to fill the template and
// make the PDF. Make sends the PDF back to /api/job-log?pdf=1&eventId=<docId>.
export const MAX_EMPLOYEES = 20;
// Checkbox list on the template (same order). The board's editor has the same list (JLD_TOOLS).
export const TOOL_GROUPS = [
  ['Hand tools', ['Pry Bar / Sledgehammer', 'Shovels / Picks', 'Wheelbarrow', 'Hand Saws', 'Crowbar', 'Hammer / Mallet', 'Tape Measure / Levels', 'Brooms / Dustpans', 'Buckets']],
  ['Power tools', ['Skill Saw', 'Sawzall / Recip Saw', 'Chipping Hammer (small)', 'Demo Hammer (large)', 'Quickie Saw / Cut-off Saw', 'Chain Saw', 'Grinder', 'Drill / Hammer Drill', 'Generator', 'Pressure Washer', 'Shop Vac', 'Fan Blowers', 'Water Pump', 'Weed Cutter', 'Compactor (plate)']],
  ['Heavy equipment', ['Trash Truck / Dump Truck', 'Bobcat / Skid Steer', 'Backhoe', 'Mini-Excavator', 'Excavator', 'Breaker / Hoe Ram', 'Compactor (rolling)', 'Boom Lift / Scissor Lift', 'Forklift']],
  ['Blades / consumables', ['Diamond Blades', 'Saw Blades / Wood Blades', 'Drill Bits', 'Dust Masks / Respirators', 'Plastic Sheeting', "Tape (Duct / Painter's)"]]
];
// {{toolPryBarSledgehammer}} etc. in the V5 template.
export const toolKey = label => 'tool' + (String(label).match(/[A-Za-z0-9]+/g) || []).map(w => w[0].toUpperCase() + w.slice(1)).join('');
const WORDS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];
const text = (v, max = 200) => String(v ?? '').replace(/\r\n?/g, '\n').slice(0, max);
const line = (v, max = 200) => text(v, max).replace(/\s*\n\s*/g, ' ').trim();
const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
const hoursOf = v => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 24 ? Math.round(n * 100) / 100 : null; };
const money = v => { const s = line(v, 20).replace(/[$,\s]/g, ''); return s && Number.isFinite(Number(s)) ? Number(s) : null; };
export const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
// Sunday that ends the Monday to Sunday week (same weeks as jobWeekFields).
export function weekEndingFor(date) {
  const d = new Date(String(date || '') + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
// Starting point for a row nobody has edited yet: what the job log row already says.
export function docFromRow(row) {
  const employees = (row.workers || []).slice(0, MAX_EMPLOYEES).map(w => ({ name: w.name, hours: w.hours ?? null, sentHome: !!w.sentHome }));
  return {
    date: row.date || '', weekEnding: weekEndingFor(row.date), customer: row.clientName || '', superintendent: '',
    siteAddress: row.jobAddress || '', employees, workDone: row.scopeOfWork || '',
    totalHours: employees.some(e => e.hours != null) ? round2(employees.reduce((t, e) => t + (e.hours || 0), 0)) : round2(row.hoursWorked),
    tools: [], toolsOther: '', disposal: [], receipts: [], notes: ''
  };
}
// Whatever the browser sends is cleaned to this shape before it is saved or sent.
export function cleanDoc(input = {}) {
  const employees = (Array.isArray(input.employees) ? input.employees : []).map(e => ({ name: line(e?.name, 80), hours: hoursOf(e?.hours), sentHome: !!e?.sentHome }))
    .filter(e => e.name || e.hours != null).slice(0, MAX_EMPLOYEES);
  const rows = (list, keys) => (Array.isArray(list) ? list : []).map(r => Object.fromEntries(keys.map(k => [k, k === 'amount' ? money(r?.[k]) : line(r?.[k], 120)])))
    .filter(r => keys.some(k => r[k] !== '' && r[k] !== null)).slice(0, 4);
  const sum = round2(employees.reduce((t, e) => t + (e.hours || 0), 0));
  const typedTotal = hoursOf(input.totalHours) ?? (Number.isFinite(Number(input.totalHours)) && Number(input.totalHours) >= 0 ? round2(input.totalHours) : null);
  return {
    date: day(input.date), weekEnding: day(input.weekEnding), customer: line(input.customer), superintendent: line(input.superintendent, 120),
    siteAddress: line(input.siteAddress), employees, workDone: text(input.workDone, 2000).trim(),
    totalHours: employees.some(e => e.hours != null) ? sum : (typedTotal ?? 0),
    tools: [...new Set((Array.isArray(input.tools) ? input.tools : []).map(t => line(t, 60)).filter(Boolean))].slice(0, 60),
    toolsOther: line(input.toolsOther, 200),
    disposal: rows(input.disposal, ['ticket', 'site', 'amount']),
    receipts: rows(input.receipts, ['vendor', 'purchased', 'amount']),
    notes: text(input.notes, 3000).trim()
  };
}
const usDate = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || ''); return m ? `${m[2]}/${m[3]}/${m[1]}` : ''; };
const fmtHours = h => h == null ? '' : String(round2(h));
const fmtMoney = n => n == null ? '' : n.toFixed(2);
// The webhook payload. jobLogTemplateForAccountingV5.docx uses reportEndDate, customerName,
// siteAddress, the employees loop (name, hours, scopeOfWork), totalHours, specialTools.
// V4 keys (employeeOne..employeeTwenty, hours) and extras (weekEnding, superintendent,
// hoursOne.., one ☒/☐ key per tool, tickets, receipts) are sent for any tag added later.
export function docPayload(doc, { docId, row = {}, generatedBy = '', returnUrl = '' } = {}) {
  const emp = doc.employees;
  const allHours = emp.map(e => e.hours).filter(h => h != null);
  const sameHours = allHours.length && allHours.every(h => h === allHours[0]);
  const payload = {
    // action "job_log_edit": the job log scenario (scheduleForInvoices) fills the template from the
    // same fields as a normal job log run, and skips the row push and Slack for it.
    action: 'job_log_edit', docId, jobId: row.jobId || '', logAction: row.action || '',
    reportEndDate: doc.date, date: doc.date, dateUs: usDate(doc.date), weekEnding: doc.weekEnding, weekEndingUs: usDate(doc.weekEnding),
    customerName: doc.customer, clientName: doc.customer, superintendent: doc.superintendent, siteAddress: doc.siteAddress, jobAddress: doc.siteAddress,
    // The template has one hours box (first row): the shared hours when everyone matches, else one line per employee.
    hours: sameHours ? fmtHours(allHours[0]) : emp.map(e => fmtHours(e.hours)).join('\n'),
    scopeOfWork: doc.workDone, totalHours: fmtHours(doc.totalHours), totalHoursNumber: doc.totalHours,
    // Notes box. The V5 template checks the tool boxes itself; only "other" tools are written here.
    // Notes box: the notes, then the tools checked on the board (the template has no tool tags).
    specialTools: [doc.notes, doc.tools.length || doc.toolsOther ? `Tools used: ${[...doc.tools, doc.toolsOther].filter(Boolean).join(', ')}` : ''].filter(Boolean).join('\n\n'),
    notes: doc.notes, toolsUsed: doc.tools, toolsOther: doc.toolsOther, toolsUsedText: [...doc.tools, doc.toolsOther].filter(Boolean).join(', '),
    // V5 template loop: {{#employees}}{{name}} {{hours}} {{scopeOfWork}}{{/employees}}, one table row
    // per employee. The description goes on the first row only (same as the old PDFs).
    // Same shape the job log webhook sends, so scheduleForInvoices' "Each employee" feeder works as is.
    assignedWorkers: emp.map(e => ({ workerName: e.name, hoursWorked: e.hours ?? 0, sentHome: e.sentHome })),
    hoursWorked: doc.totalHours, reportDate: doc.date,
    employees: emp.map((e, i) => ({ name: e.name, hours: fmtHours(e.hours), scopeOfWork: i === 0 ? doc.workDone : '', sentHome: e.sentHome, hoursNumber: e.hours })),
    disposalTickets: doc.disposal, materialReceipts: doc.receipts,
    disposalTotal: fmtMoney(doc.disposal.reduce((t, r) => t + (r.amount || 0), 0)), receiptsTotal: fmtMoney(doc.receipts.reduce((t, r) => t + (r.amount || 0), 0)),
    generatedBy, generatedAt: new Date().toISOString(),
    pdfReturnUrl: returnUrl
  };
  payload.toolsRequired = payload.specialTools;
  if (!payload.employees.length && doc.workDone) payload.employees = [{ name: '', hours: '', scopeOfWork: doc.workDone, sentHome: false, hoursNumber: null }];
  const used = new Set(doc.tools);
  for (const [, items] of TOOL_GROUPS) for (const t of items) payload[toolKey(t)] = used.has(t) ? '\u2612' : '\u2610';
  WORDS.forEach((w, i) => { payload['employee' + w] = emp[i]?.name || ''; payload['hours' + w] = fmtHours(emp[i]?.hours); });
  doc.disposal.concat(Array(4).fill({})).slice(0, 4).forEach((r, i) => Object.assign(payload, { [`ticket${i + 1}Number`]: r.ticket || '', [`ticket${i + 1}Site`]: r.site || '', [`ticket${i + 1}Amount`]: fmtMoney(r.amount ?? null) }));
  doc.receipts.concat(Array(4).fill({})).slice(0, 4).forEach((r, i) => Object.assign(payload, { [`receipt${i + 1}Vendor`]: r.vendor || '', [`receipt${i + 1}Purchased`]: r.purchased || '', [`receipt${i + 1}Amount`]: fmtMoney(r.amount ?? null) }));
  return payload;
}
