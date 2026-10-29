// Fills the Daily Job Log Word template (templates/jobLogTemplateForAccountingV5.docx,
// embedded in job-log-template.mjs) on the server, so Generate PDF can send the finished
// .docx to Make as base64 "data". Same tags Make's Word module filled before:
// {{reportEndDate}} {{customerName}} {{siteAddress}} {{totalHours}} {{specialTools}} and the
// table row loop {{#employees}}{{name}} | {{hours}} | {{scopeOfWork}}{{/employees}}.
// Any other {{tag}} added to the template is filled from the payload field of the same name.
// No dependencies: reuses the zip reader/writer from eod-xlsx.mjs.
import { readZip, writeZip } from './eod-xlsx.mjs';
import { JOB_LOG_TEMPLATE_B64 } from './job-log-template.mjs';

const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Newlines become Word line breaks inside the same run.
const wordText = v => esc(v).replace(/\r\n?/g, '\n').split('\n').join('</w:t><w:br/><w:t xml:space="preserve">');
const T_RE = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;

// Word often splits "{{totalHours}}" over several runs (spell check, edits). Pull the rest of
// an open tag into the run where it starts so every tag sits in one <w:t>.
export function mergeSplitTags(xml) {
  const parts = [...xml.matchAll(T_RE)].map(m => ({ start: m.index, end: m.index + m[0].length, attrs: m[1] || '', text: m[2], changed: false }));
  const open = t => { const o = t.lastIndexOf('{{'), c = t.lastIndexOf('}}'); return o > c || (t.endsWith('{') && !t.endsWith('{{')); };
  for (let i = 0; i < parts.length; i++) {
    let j = i + 1;
    while (open(parts[i].text) && j < parts.length && j - i <= 12) {
      parts[i].text += parts[j].text; parts[j].text = ''; parts[i].changed = parts[j].changed = true; j++;
    }
  }
  let out = '', at = 0;
  for (const p of parts) {
    out += xml.slice(at, p.start);
    out += p.changed ? `<w:t xml:space="preserve">${p.text}</w:t>` : xml.slice(p.start, p.end);
    at = p.end;
  }
  return out + xml.slice(at);
}
function fillTags(xml, values) {
  return xml.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, k) => {
    const v = values[k];
    return v == null || typeof v === 'object' ? '' : wordText(v);
  }).replace(/<w:t>([^<]*<w:br\/>)/g, '<w:t xml:space="preserve">$1');
}
// The table row holding {{#employees}} ... {{/employees}} is repeated once per employee.
function fillLoop(xml, name, items) {
  const s = xml.indexOf(`{{#${name}}}`);
  if (s < 0) return xml;
  const rowStart = Math.max(xml.lastIndexOf('<w:tr ', s), xml.lastIndexOf('<w:tr>', s));
  const close = xml.indexOf(`{{/${name}}}`, s);
  const rowEnd = xml.indexOf('</w:tr>', close) + '</w:tr>'.length;
  if (rowStart < 0 || close < 0 || rowEnd < close) throw new Error(`Template loop {{#${name}}} must open and close in one table row`);
  const row = xml.slice(rowStart, rowEnd).replace(`{{#${name}}}`, '').replace(`{{/${name}}}`, '');
  const rows = items.map(item => fillTags(row, item)).join('');
  return xml.slice(0, rowStart) + rows + xml.slice(rowEnd);
}
export function buildJobLogDocx(payload, templateB64 = JOB_LOG_TEMPLATE_B64) {
  const entries = readZip(Buffer.from(templateB64, 'base64'));
  for (const e of entries) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(e.name)) continue;
    let xml = mergeSplitTags(e.data.toString('utf8'));
    xml = fillLoop(xml, 'employees', (payload.employees || []).map(x => ({ ...payload, ...x })));
    e.data = Buffer.from(fillTags(xml, payload), 'utf8');
  }
  return writeZip(entries);
}
// "Raw Job Log - <address>,<date>.docx", the same name the Make scenario used.
export const jobLogFileName = p => `Raw Job Log - ${String(p.siteAddress || p.jobAddress || 'Job').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim()},${p.reportEndDate || ''}.docx`;
