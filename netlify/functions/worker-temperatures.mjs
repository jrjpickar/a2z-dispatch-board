// Worker temperature from the GHL contact custom field {{contact.temperature}} (Dropdown, single).
//   GET /api/worker-temperatures?ids=<contactId>,...&phones=<phone>,...
//     -> { ok, temperatures: { [contactId]: "Hot" | "", ["phone:<10 digits>"]: "Hot" | "" }, pending: [...] }
//   &refresh=1 re-reads every one from GHL now.
// Workers with a contact id are looked up by id; workers without one by phone.
// Each call works for at most ~6 seconds (Netlify cuts sync functions off at 10s);
// whatever wasn't reached comes back in "pending" and the board asks again.
// Values are cached per contact for WORKER_TEMPERATURE_CACHE_SECONDS (default 600).
// Read only: nothing is written to GHL.
import { db, ensureSchema } from './db.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { temperatureFieldId, getContactRaw, customFieldValue, findContactIdByPhone } from '../../lib/ghl.mjs';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const BUDGET_MS = 6000, BATCH = 5;
let fieldIdCache = null; // per warm instance
const phoneKey = p => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `phone:${d}` : ''; };

export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const started = Date.now();
    const params = new URL(request.url).searchParams;
    const list = name => String(params.get(name) || '').split(',').map(s => s.trim()).filter(Boolean);
    const ids = [...new Set(list('ids').filter(id => ID.test(id)))].slice(0, 300);
    const phones = [...new Set(list('phones').map(phoneKey).filter(Boolean))].slice(0, 300);
    const keys = [...ids, ...phones];
    if (!keys.length) return json({ ok: true, temperatures: {}, pending: [] });
    const sql = db(); await ensureSchema(sql);
    const ttl = Math.max(30, Math.min(86400, Number(process.env.WORKER_TEMPERATURE_CACHE_SECONDS) || 600));
    const refresh = params.get('refresh') === '1';
    // contact_id holds either a GHL contact id or "phone:<10 digits>".
    const cached = await sql`select contact_id, value, extract(epoch from (now() - fetched_at)) as age from dispatch_worker_temperature where contact_id = any(${keys})`;
    const byKey = new Map(cached.map(r => [r.contact_id, r]));
    const temperatures = {}, stale = [];
    for (const key of keys) {
      const row = byKey.get(key);
      if (row) temperatures[key] = row.value;
      if (refresh || !row || Number(row.age) > ttl) stale.push(key);
    }
    const freshKeys = new Set();
    const save = async (key, value) => {
      temperatures[key] = value; freshKeys.add(key);
      await sql`insert into dispatch_worker_temperature (contact_id, value, fetched_at) values (${key}, ${value}, now())
        on conflict (contact_id) do update set value = excluded.value, fetched_at = now()`;
    };
    let error = '', rateLimited = false;
    if (stale.length) {
      if (!fieldIdCache) fieldIdCache = await temperatureFieldId();
      const fieldId = fieldIdCache;
      const lookup = async key => {
        try {
          let contactId = key;
          if (key.startsWith('phone:')) {
            contactId = await findContactIdByPhone(key.slice(6));
            if (!contactId) return save(key, '');
          }
          const value = customFieldValue(await getContactRaw(contactId), fieldId).slice(0, 60);
          await save(key, value);
          if (contactId !== key) await save(contactId, value);
        } catch (e) {
          if ([400, 404, 422].includes(e.status)) return save(key, '');
          if (e.status === 429) { rateLimited = true; return; }
          console.error('Worker temperature lookup failed', key, e.message);
          error = e.status === 401 || e.status === 403 ? 'Could not read Temperature from GHL. The token needs contacts.readonly.' : (error || e.message);
        }
      };
      for (let i = 0; i < stale.length && !rateLimited && Date.now() - started < BUDGET_MS; i += BATCH) {
        await Promise.all(stale.slice(i, i + BATCH).map(lookup));
      }
    }
    // Anything not refreshed this call (time budget, rate limit, or a GHL error) is asked for again.
    return json({ ok: !error, temperatures, pending: stale.filter(key => !freshKeys.has(key)), ...(error ? { error } : {}), ...(rateLimited ? { rateLimited: true } : {}) });
  } catch (error) { return errorResponse(error); }
}
