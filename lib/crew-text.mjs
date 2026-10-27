// Crew schedule text (action crewText), done on the server.
//
// After Assign selected / Send schedule now, the board queues one crew_text effect
// (no Make run). This builds the whole day's schedule from the database, texts it
// to the workers in that assignment only (textWorkers) through Twilio, and logs each text in that worker's GHL
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
    .map(w => ({ id: String(w.id || w.contactId || ''), name: String(w.name || w.workerName || '').replace(/\s+/g, ' ').trim(), phone: String(w.phone || w.workerPhone || '') }))
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
const sameWorker = (a, b) => (a.id && b.id && a.id === b.id) || (toE164(a.phone) && toE164(a.phone) === toE164(b.phone)) || a.name.toLowerCase() === b.name.toLowerCase();

// jobs: the GHL job list the board shows. states: shared state records ({ jobId, active, ...data }).
// Returns { text, blocks, workers: [{ name, phone (E.164), contactId }] }.
export function buildCrewSchedule(jobs, states, date, { roster = [] } = {}) {
  const d = new Date(String(date || '') + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || Number.isNaN(d.getTime())) return { text: '', blocks: [], workers: [] };
  const byId = new Map((states || []).map(s => [String(s.jobId), s]));
  const day = (jobs || []).map(job => ({ job, state: byId.get(String(job.id)) }))
    .filter(({ job, state }) => state?.active !== false && normDate(pick(state, job, 'reportDate')) === date && crewOf(state).length)
    .map(({ job, state }) => {
      const night = !!(state && (state.nightWork === true || state.nightWork === 'true'));
      const hourly = isHourly(job, state);
      return { job, state, crew: crewOf(state), hourly, start: normTime(pick(state, job, 'reportTime')), end: normTime(pick(state, job, 'reportEndTime')), group: night ? 2 : hourly ? 1 : 0 };
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
      const count = day.filter(o => o.crew.some(c => sameWorker(c, w))).length;
      return count > 1 ? `* ${w.name} ${Math.round(16 / count) / 2}hr` : `* ${w.name}`;
    }).join('\n'));
    return parts.join('\n\n');
  });
  const workers = [];
  for (const { crew } of day) for (const w of crew) {
    const fromRoster = (roster || []).find(r => (w.id && r.id === w.id) || r.name === w.name);
    const phone = toE164(w.phone || fromRoster?.phone || '');
    if (!phone || workers.some(x => x.phone === phone)) continue;
    workers.push({ name: w.name, phone, contactId: w.id || fromRoster?.id || '' });
  }
  return { text: [header, ...blocks, SCHEDULE_TEXT_SIGNOFF].join('\n\n\n\n'), blocks: [header, ...blocks, SCHEDULE_TEXT_SIGNOFF], workers };
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
export const CREW_TEXT_LEAD_MS = 12 * 3600e3;
// Same timing as the Make assign: Assign selected texts 12 hours before the job
// starts (right away if that's already past); Send schedule now texts right away.
export function crewTextDelayMs(payload, now = Date.now()) {
  if (payload?.rapidAssign === true || payload?.triggeredBy === 'rapid_assign') return 0;
  const start = pacificToUtc(normDate(payload?.reportDate), normTime(payload?.reportTime));
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.min(start - CREW_TEXT_LEAD_MS - now, 120 * 86400e3));
}

// ---------- Loading the day from the database ----------
async function loadDay(sql, date) {
  const [cache] = await sql`select data from dispatch_feed_cache where key = 'ghl-jobs'`;
  const cached = cache && (typeof cache.data === 'string' ? JSON.parse(cache.data) : cache.data);
  const rows = await sql`select job_id, active, data from job_shared_state where active = true`;
  const states = rows.map(r => ({ ...(typeof r.data === 'string' ? JSON.parse(r.data) : r.data), jobId: r.job_id, active: r.active }));
  // Same job list the board shows (the shared GHL feed). If it has never loaded, use the saved job details.
  const jobs = Array.isArray(cached) ? cached : states.map(s => ({ id: s.jobId, name: s.jobAddress || '', clientName: s.clientName || '', jobType: s.jobType || '', customFields: [] }));
  return buildCrewSchedule(jobs, states, date);
}

// ---------- Twilio ----------
function need(name) { const v = process.env[name]; if (!v) throw new Error(`${name} is not set in Netlify`); return v; }
async function twilioSms(to, body) {
  const sid = need('TWILIO_ACCOUNT_SID'), token = need('TWILIO_AUTH_TOKEN');
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID, from = process.env.TWILIO_FROM_NUMBER;
  if (!service && !from) throw new Error('TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID must be set in Netlify');
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, Body: body, ...(service ? { MessagingServiceSid: service } : { From: from }) })
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
async function marketplaceToken(sql, loc, force = false) {
  const [row] = await sql`select value from dispatch_settings where key = ${oauthKey(loc)}`;
  let token = row && (typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
  if (!token?.refresh_token) throw new Error('GHL Marketplace app is not connected for this location. Install (or update) the dispatch board Marketplace app so /api/oauth/callback can save its token.');
  if (force || !token.access_token || Number(token.expiresAt) <= Date.now() + 60000) {
    token = await oauthTokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token, user_type: 'Location' });
    if (!token.locationId) token.locationId = loc;
    await saveOauthToken(sql, token);
  }
  return token.access_token;
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
async function ensureTable(sql) {
  await sql`create table if not exists crew_text_sends (
    effect_id text not null, phone text not null, step text not null, ref text not null default '', created_at timestamptz not null default now(),
    primary key (effect_id, phone, step))`;
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
    const day = await loadDay(sql, String(payload.reportDate || ''));
    // Only the workers just assigned get texted (payload.textWorkers). Nobody else on
    // the job or the day is texted again. A run without textWorkers (a board tab
    // opened before this update) texts nobody.
    const workers = [];
    {
      for (const w of Array.isArray(payload.textWorkers) ? payload.textWorkers : []) {
        const phone = toE164(w?.workerPhone || w?.phone || '');
        if (!phone || workers.some(x => x.phone === phone)) continue;
        const onDay = day.workers.find(x => x.phone === phone);
        // Taken off the job (or the day) before the text went out: skip them.
        if (!onDay) continue;
        workers.push({ name: String(w.workerName || w.name || onDay?.name || ''), phone, contactId: String(w.contactId || onDay?.contactId || '') });
      }
    }
    plan = { parts: smsParts(day.blocks), workers };
    await mark('*', 'plan', JSON.stringify(plan));
  }
  if (!plan.workers.length || !plan.parts.length) return { fileName: '', sent: 0 };
  const dryRun = flag('CREW_TEXT_DRY_RUN', false), logGhl = flag('CREW_TEXT_GHL_LOG', true);
  const errors = [];
  const runWorker = async worker => {
    for (let i = 0; i < plan.parts.length; i++) {
      let sms = done.has(`${worker.phone}|sms:${i}`) ? JSON.parse(done.get(`${worker.phone}|sms:${i}`)) : null;
      try {
        if (!sms) { sms = dryRun ? { sid: `dry-${id}-${worker.phone}-${i}`, from: '' } : await twilioSms(worker.phone, plan.parts[i]); await mark(worker.phone, `sms:${i}`, JSON.stringify(sms)); }
      } catch (error) { errors.push(`${worker.name}: text not sent (${error.message})`); return; }
      if (!logGhl || dryRun || done.has(`${worker.phone}|ghl:${i}`)) continue;
      try { await mark(worker.phone, `ghl:${i}`, await logToGhl(sql, worker, plan.parts[i], sms)); }
      catch (error) { errors.push(`${worker.name}: texted, GHL log failed (${error.message})`); }
    }
  };
  // A few at a time keeps a full day of crew inside the function time limit.
  const queue = [...plan.workers];
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, async () => { while (queue.length) await runWorker(queue.shift()); }));
  if (errors.length) throw new Error(`Crew text: ${errors.slice(0, 6).join('; ')}${errors.length > 6 ? ` (+${errors.length - 6} more)` : ''}. Retry only redoes these.`);
  return { fileName: '', sent: plan.workers.length };
}
