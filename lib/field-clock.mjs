// Field app clock in / clock out (see netlify/functions/field-clock.mjs).
//
// A worker clocks in and out on the job card in the field app. Location is
// required for both: the phone sends its GPS reading, the server works out how
// far that is from the job and saves it. While someone is on the clock and the
// app is open, the phone also sends a reading every few minutes (live location).
// Clock out needs a short summary of the work done. Each clock in / clock out
// posts one run to the clock webhook in Make (lib/effects.mjs, kind "clock").
//
// Env (all optional):
//   CLOCK_ONSITE_FT        on site within this many feet of the job (default 500)
//   CLOCK_NEAR_FT          near site within this many feet (default 1000)
//   CLOCK_MAX_ACCURACY_FT  refuse readings less accurate than this (default 1000)
//   GOOGLE_MAPS_API_KEY    optional. Job addresses are looked up for free (US Census
//                          Geocoder, then OpenStreetMap) without it; see jobPin.
export const TZ = 'America/Los_Angeles';
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export const clockRules = () => ({
  onsite: num(process.env.CLOCK_ONSITE_FT, 500),
  near: num(process.env.CLOCK_NEAR_FT, 1000),
  maxAcc: num(process.env.CLOCK_MAX_ACCURACY_FT, 1000)
});
export const PING_MIN_MS = 60000;
// A shift still open this long is treated as a forgotten clock out (see field-clock.mjs).
export const AUTO_CLOSE_MS = 16 * 3600000; // the server ignores live pings closer together than this
export const TRAIL_MAX = 120;

// ---------- Pacific dates and Make's formats ----------
const parts = (iso, opts) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
export const pacificDay = (iso = new Date().toISOString()) => { const p = parts(iso, { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${p.year}-${p.month}-${p.day}`; };
// 11/03/26
export const mdy = iso => { const p = parts(iso, { year: '2-digit', month: '2-digit', day: '2-digit' }); return `${p.month}/${p.day}/${p.year}`; };
// 07:05AM
export const hhmmAmPm = iso => { const p = parts(iso, { hour: '2-digit', minute: '2-digit', hour12: true }); return `${p.hour}:${p.minute}${String(p.dayPeriod || '').toUpperCase()}`; };
export const hoursBetween = (a, b) => Math.round(Math.max(0, Date.parse(b) - Date.parse(a)) / 36000) / 100;

// Is the job on today (Pacific)? Multi-day and overnight jobs count until their end date.
export function jobIsToday(job, today = pacificDay()) {
  const start = String(job?.reportDate || ''); if (!start) return false;
  const end = String(job?.reportEndDate || '') || start;
  return start <= today && today <= (end < start ? start : end);
}

// ---------- Location ----------
const R_FT = 20902231;
const rad = d => d * Math.PI / 180;
export function distanceFt(a, b) {
  const dLa = rad(b.lat - a.lat), dLo = rad(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLo / 2) ** 2;
  return Math.round(2 * R_FT * Math.asin(Math.sqrt(h)));
}
// Checks the phone's reading. Throws a 4xx-ready error the app shows as is.
export function cleanReading(raw, rules = clockRules()) {
  const lat = Number(raw?.lat), lng = Number(raw?.lng), acc = Number(raw?.acc);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    const e = new Error('Location is required to clock in or out. Turn on location and try again.'); e.status = 400; e.code = 'location_required'; throw e;
  }
  const accFt = Number.isFinite(acc) && acc > 0 ? Math.round(acc) : null;
  if (accFt !== null && accFt > rules.maxAcc) {
    const e = new Error(`Your location is too rough (accurate to ${accFt.toLocaleString('en-US')} ft). Step outside and try again.`); e.status = 422; e.code = 'location_rough'; e.acc = accFt; throw e;
  }
  return { lat: +lat.toFixed(6), lng: +lng.toFixed(6), acc: accFt };
}
export function judge(reading, pin, rules = clockRules()) {
  if (!pin) return { ...reading, dist: null, status: 'unknown' };
  const dist = distanceFt(reading, pin);
  return { ...reading, dist, status: dist <= rules.onsite ? 'onsite' : dist <= rules.near ? 'near' : 'away' };
}
export const mapLink = loc => loc && Number.isFinite(loc.lat) ? `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}` : '';

// Job map pin from its address: looked up once per address and kept in job_geocode.
// Free by default, no key needed:
//   1. US Census Geocoder (geocoding.geo.census.gov): free, no key, US street addresses.
//   2. OpenStreetMap Nominatim, if the Census has no match (free, about one lookup a
//      second at most, which is far more than one per job address needs).
// GOOGLE_MAPS_API_KEY, if set, is tried first instead (optional, not needed).
// Each provider answers 'found' {lat,lng}, 'none' (no match) or null (couldn't ask).
const UA = 'A2Z-Dispatch-Board/1.9 (field app time clock)';
const okPin = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
async function askJson(url, headers = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json', 'user-agent': UA, ...headers } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
const geocoders = {
  async google(addr) {
    const key = process.env.GOOGLE_MAPS_API_KEY; if (!key) return null;
    const data = await askJson(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${encodeURIComponent(key)}`);
    const loc = data?.results?.[0]?.geometry?.location;
    if (loc) return okPin(Number(loc.lat), Number(loc.lng)) || 'none';
    return data?.status === 'ZERO_RESULTS' ? 'none' : null;
  },
  async census(addr) {
    const data = await askJson(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(addr)}&benchmark=Public_AR_Current&format=json`);
    const c = data?.result?.addressMatches?.[0]?.coordinates;
    if (c) return okPin(Number(c.y), Number(c.x)) || 'none';
    return Array.isArray(data?.result?.addressMatches) ? 'none' : null;
  },
  async osm(addr) {
    const data = await askJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(addr)}`, process.env.URL ? { referer: process.env.URL } : {});
    if (Array.isArray(data) && data[0]) return okPin(Number(data[0].lat), Number(data[0].lon)) || 'none';
    return Array.isArray(data) ? 'none' : null;
  }
};
export async function geocode(addr) {
  let couldNotAsk = false;
  for (const name of ['google', 'census', 'osm']) {
    let r = null;
    try { r = await geocoders[name](addr); } catch { r = null; }
    if (r && r !== 'none') return { pin: r, source: name };
    if (r === null && !(name === 'google' && !process.env.GOOGLE_MAPS_API_KEY)) couldNotAsk = true;
  }
  return { pin: null, retry: couldNotAsk };
}
// Only what's already saved (no lookup): { known, pin }. The punch uses this so the
// worker never waits on a lookup service; a new address is looked up right after.
export async function cachedPin(sql, jobId, address) {
  const addr = String(address || '').trim();
  if (!addr) return { known: true, pin: null };
  const [row] = await sql`select address, lat, lng from job_geocode where job_id = ${String(jobId)}`;
  if (row && row.address === addr) return { known: true, pin: row.lat == null ? null : { lat: Number(row.lat), lng: Number(row.lng) } };
  return { known: false, pin: null };
}
export async function jobPin(sql, jobId, address) {
  const addr = String(address || '').trim();
  if (!addr) return null;
  const [row] = await sql`select address, lat, lng from job_geocode where job_id = ${String(jobId)}`;
  if (row && row.address === addr) return row.lat == null ? null : { lat: Number(row.lat), lng: Number(row.lng) };
  const { pin, retry } = await geocode(addr);
  if (!pin && retry) return null; // a lookup service was down: try again on the next punch
  await sql`insert into job_geocode (job_id, address, lat, lng, updated_at) values (${String(jobId)}, ${addr}, ${pin?.lat ?? null}, ${pin?.lng ?? null}, now())
    on conflict (job_id) do update set address = excluded.address, lat = excluded.lat, lng = excluded.lng, updated_at = now()`;
  return pin;
}

// ---------- Work summary ----------
// The statements the worker agrees to on clock out (English is the record; the app
// shows the Spanish text to Spanish users, and `lang` says which one they saw).
export const CLOCK_OUT_CERT = Object.freeze({
  breaks: 'By signing I hereby certify that I was given my breaks in accordance with labor laws and the above information is true to the best of my knowledge.',
  consent: 'I consent to my location being tracked during my shifts.'
});
const bad = (msg, code) => Object.assign(new Error(msg), { status: 400, code });
// Signature: a PNG drawn with a finger, as a data URL. Kept small (the app draws it at 500 px).
export function cleanSignature(raw) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(raw || ''));
  if (!m || m[1].length < 400) throw bad('Sign with your finger before you clock out.', 'signature_required');
  if (m[1].length > 90000) throw bad('That signature is too big to save. Clear it and sign again.', 'signature_big');
  return m[1];
}
export function cleanSummary(body, lang) {
  const work = String(body?.work || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const notes = String(body?.notes || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (work.length < 3) throw bad('Write a few words about the work done before you clock out.', 'summary_required');
  if (body?.breaks !== 'certified') throw bad('Check the breaks statement to clock out.', 'breaks_required');
  if (body?.locationConsent !== true) throw bad('Check the location consent to clock out.', 'consent_required');
  return {
    work, notes, lang: lang === 'es' ? 'es' : 'en',
    breaksCertified: true, locationConsent: true,
    certification: CLOCK_OUT_CERT.breaks, consentText: CLOCK_OUT_CERT.consent
  };
}

// ---------- Make payload (webhook kind "clock") ----------
// date / time are the punch's own (clock in for clockIn, clock out for clockOut),
// as MM/DD/YY and 07:05AM Pacific. hoursWorked is 0 on clockIn.
export function clockPayload(action, shift) {
  const cin = shift.clock_in, cout = shift.clock_out;
  const p = action === 'clockOut' ? cout : cin;
  const summary = shift.summary || {};
  return {
    action,
    date: mdy(p.at), time: hhmmAmPm(p.at),
    hoursWorked: action === 'clockOut' ? hoursBetween(cin.at, cout.at) : 0,
    scopeOfWork: action === 'clockOut' ? summary.work || '' : '',
    notes: action === 'clockOut' ? summary.notes || '' : '',
    employeeName: shift.worker_name, workerName: shift.worker_name, workerPhone: shift.worker_phone || '',
    jobId: shift.job_id, jobAddress: shift.job_address || '', clientName: shift.client_name || '', jobScopeOfWork: shift.job_scope || '',
    clockInDate: mdy(cin.at), clockInTime: hhmmAmPm(cin.at),
    clockOutDate: cout ? mdy(cout.at) : '', clockOutTime: cout ? hhmmAmPm(cout.at) : '',
    clockInAt: cin.at, clockOutAt: cout ? cout.at : '', timeZone: TZ,
    latitude: p.lat, longitude: p.lng, accuracyFt: p.acc ?? '', distanceFt: p.dist ?? '', locationStatus: p.status, mapLink: mapLink(p),
    autoClosed: action === 'clockOut' && !!cout?.autoClosed,
    language: summary.lang || '', shiftId: shift.id,
    // Clock out sign-off (empty on clockIn and on an auto-closed shift).
    breaksCertified: action === 'clockOut' && typeof summary.breaksCertified === 'boolean' ? summary.breaksCertified : '',
    locationConsent: action === 'clockOut' ? summary.locationConsent === true : '',
    certification: action === 'clockOut' ? summary.certification || '' : '',
    signedBy: action === 'clockOut' && shift.signature ? shift.worker_name : '',
    signedAt: action === 'clockOut' && shift.signature ? summary.at || cout?.at || '' : '',
    signature: action === 'clockOut' ? shift.signature || '' : '' // base64 PNG (no data: prefix)
  };
}

// What the field app gets back for one shift.
export function shiftView(row) {
  if (!row) return null;
  const j = v => typeof v === 'string' ? JSON.parse(v) : v;
  const cin = j(row.clock_in), cout = j(row.clock_out), last = j(row.last_loc);
  return {
    id: row.id, jobId: row.job_id, jobAddress: row.job_address || '', clientName: row.client_name || '',
    clockIn: cin ? { at: cin.at, status: cin.status, dist: cin.dist } : null,
    clockOut: cout ? { at: cout.at, status: cout.status, dist: cout.dist } : null,
    lastAt: last?.at || cin?.at || '', summary: j(row.summary) || null
  };
}
