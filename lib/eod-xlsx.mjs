// Builds the filled-in Job Costing Worksheet (.xlsx) for a Complete EOD Sheet
// submission. Starts from the real template (templates/Job_Costing_Worksheet_V2.xlsx,
// embedded in eod-template.mjs) and only writes values into the "Job Costing"
// tab, so every style, formula and the other tabs stay exactly as designed.
// No dependencies: a minimal zip reader/writer on top of node:zlib.
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { JOB_COSTING_TEMPLATE_B64 } from './eod-template.mjs';

// Template rows for each section, in the same order as EOD_SECTIONS in index.html.
const SECTION_ROWS = { Interior: [8, 14], Exterior: [19, 25], Grading: [30, 34] };
const SUBTOTAL_ROW = { Interior: 15, Exterior: 26, Grading: 35 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Template is not a valid xlsx');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function writeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8'), comp = deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp); centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const xmlEscape = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Sets one cell's value, keeping its style. Formula cells keep their formula
// and only get a fresh cached value, so viewers that don't recalculate
// (previews, Drive thumbnails) still show the right numbers.
function setCell(xml, ref, value) {
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const match = xml.match(re);
  if (!match) throw new Error(`Template cell ${ref} not found`);
  const attrs = match[1].replace(/\s+t="[^"]*"/, '');
  const inner = match[2] || '';
  const formula = (inner.match(/<f[\s\S]*?(?:\/>|<\/f>)/) || [''])[0];
  let cell;
  if (value === null || value === undefined || value === '') cell = formula ? `<c r="${ref}"${attrs}>${formula}<v>0</v></c>` : `<c r="${ref}"${attrs}/>`;
  else if (typeof value === 'number') cell = `<c r="${ref}"${attrs}>${formula}<v>${value}</v></c>`;
  else cell = `<c r="${ref}"${attrs} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(noDashes(value))}</t></is></c>`;
  return xml.replace(re, cell);
}

function sheetPathFor(entries, sheetName) {
  const text = name => entries.find(e => e.name === name).data.toString('utf8');
  const workbook = text('xl/workbook.xml'), rels = text('xl/_rels/workbook.xml.rels');
  const sheet = workbook.match(new RegExp(`<sheet [^>]*name="${xmlEscape(sheetName)}"[^>]*r:id="([^"]+)"`));
  const target = sheet && rels.match(new RegExp(`Id="${sheet[1]}"[^>]*Target="([^"]+)"`));
  if (!target) throw new Error(`Sheet "${sheetName}" not found in template`);
  return 'xl/' + target[1].replace(/^\/?xl\//, '');
}

function usDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || '');
}

// No em/en dashes anywhere in the generated sheet or file name.
const noDashes = v => String(v == null ? '' : v).replace(/\s*[\u2014\u2013]\s*/g, ' - ');

export function eodFileName(sheet) {
  const safe = noDashes(sheet.jobName || sheet.jobAddress || sheet.jobId || 'Job').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `EOD Sheet - ${safe} - ${sheet.date || 'undated'}.xlsx`;
}

// Returns the filled workbook as a Buffer.
export function buildEodWorkbook(sheet) {
  const entries = readZip(Buffer.from(JOB_COSTING_TEMPLATE_B64, 'base64'));
  const path = sheetPathFor(entries, 'Job Costing');
  const entry = entries.find(e => e.name === path);
  let xml = entry.data.toString('utf8');
  xml = setCell(xml, 'C2', sheet.jobName || sheet.jobAddress || '');
  xml = setCell(xml, 'C3', usDate(sheet.date));
  const lines = Array.isArray(sheet.lines) ? sheet.lines : [];
  let totalCost = 0;
  for (const [section, [first, last]] of Object.entries(SECTION_ROWS)) {
    const sectionLines = lines.filter(l => l.section === section).sort((a, b) => num(a.line) - num(b.line));
    let subtotal = 0;
    for (let row = first; row <= last; row++) {
      const line = sectionLines[row - first] || {};
      const qty = num(line.qty), rate = num(line.rate), total = Math.round(qty * rate * 100) / 100;
      xml = setCell(xml, `B${row}`, line.description || '');
      xml = setCell(xml, `C${row}`, line.qty === '' || line.qty == null || !qty ? '' : qty);
      xml = setCell(xml, `D${row}`, line.rate === '' || line.rate == null || !rate ? '' : rate);
      xml = setCell(xml, `E${row}`, total);
      subtotal += total;
    }
    subtotal = Math.round(subtotal * 100) / 100;
    xml = setCell(xml, `E${SUBTOTAL_ROW[section]}`, subtotal);
    totalCost += subtotal;
  }
  totalCost = Math.round(totalCost * 100) / 100;
  const markup = num(sheet.markupPercent) / 100;
  xml = setCell(xml, 'E37', totalCost);
  xml = setCell(xml, 'E38', markup ? markup : '');
  xml = setCell(xml, 'E39', Math.round(totalCost * (1 + markup) * 100) / 100);
  entry.data = Buffer.from(xml, 'utf8');
  // Ask Excel / Sheets to recalculate everything on open as a safety net.
  const wb = entries.find(e => e.name === 'xl/workbook.xml');
  wb.data = Buffer.from(wb.data.toString('utf8').replace(/<calcPr[^>]*\/>/, '<calcPr fullCalcOnLoad="1"/>'), 'utf8');
  return writeZip(entries);
}

export function eodWorkbookAttachment(sheet) {
  const data = buildEodWorkbook(sheet);
  return {
    fileName: eodFileName(sheet),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: data.length,
    data: data.toString('base64')
  };
}
