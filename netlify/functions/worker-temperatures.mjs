// Worker temperature from the GHL contact custom field {{contact.temperature}} (Dropdown, single).
//   GET /api/worker-temperatures?ids=<contactId>,<contactId>,...        -> { ok, temperatures: { [contactId]: "Hot" | "" } }
//   GET /api/worker-temperatures?ids=...&refresh=1                      (re-reads every id from GHL now)
// Values are cached per contact for WORKER_TEMPERATURE_CACHE_SECONDS (default 600).
// Read only: nothing is written to GHL.
import { db, ensureSchema } from './db.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { temperatureFieldId, getContactRaw, customFieldValue } from '../../lib/ghl.mjs';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
let fieldIdCache = null; // per warm instance

export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const params = new URL(request.url).searchParams;
    const ids = [...new Set(String(params.get('ids') || '').split(',').map(s => s.trim()).filter(id => ID.test(id)))].slice(0, 300);
    if (!ids.length) return json({ ok: true, temperatures: {} });
    const sql = db(); await ensureSchema(sql);
    const ttl = Math.max(30, Math.min(86400, Number(process.env.WORKER_TEMPERATURE_CACHE_SECONDS) || 600));
    const refresh = params.get('refresh') === '1';
    const cached = await sql`select contact_id, value, extract(epoch from (now() - fetched_at)) as age from dispatch_worker_temperature where contact_id = any(${ids})`;
    const temperatures = {}, stale = [];
    const byId = new Map(cached.map(r => [r.contact_id, r]));
    for (const id of ids) {
      const row = byId.get(id);
      if (row) temperatures[id] = row.value;
      if (refresh || !row || Number(row.age) > ttl) stale.push(id);
    }
    let error = '';
    if (stale.length) {
      try {
        if (!fieldIdCache) fieldIdCache = await temperatureFieldId();
        const fieldId = fieldIdCache;
        // Small batches keep well under GHL's rate limit; stop early so the function never times out.
        const started = Date.now();
        for (let i = 0; i < stale.length && Date.now() - started < 18000; i += 6) {
          await Promise.all(stale.slice(i, i + 6).map(async id => {
            try {
              const value = customFieldValue(await getContactRaw(id), fieldId).slice(0, 60);
              temperatures[id] = value;
              await sql`insert into dispatch_worker_temperature (contact_id, value, fetched_at) values (${id}, ${value}, now())
                on conflict (contact_id) do update set value = excluded.value, fetched_at = now()`;
            } catch (e) {
              if (e.status === 404 || e.status === 400 || e.status === 422) {
                await sql`insert into dispatch_worker_temperature (contact_id, value, fetched_at) values (${id}, '', now())
                  on conflict (contact_id) do update set value = '', fetched_at = now()`;
                temperatures[id] = temperatures[id] ?? '';
              } else throw e;
            }
          }));
        }
      } catch (e) {
        console.error('Worker temperature lookup failed', e);
        fieldIdCache = null;
        error = /custom ?field/i.test(e.message) ? e.message : 'Could not read Temperature from GHL. The token needs contacts.readonly.';
      }
    }
    return json({ ok: !error, temperatures, ...(error ? { error } : {}) });
  } catch (error) { return errorResponse(error); }
}
