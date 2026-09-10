// Dispatcher-only: enable/view/revoke who is allowed to sign in to the
// read-only field app. Same trust model as the rest of the board (same-origin
// write) -- see lib/http.mjs authorizeWrite. No access code involved anymore:
// being on this enabled list, plus knowing your own phone number, is the
// whole login (see driver-auth.mjs).
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { driverKeyFor } from '../../lib/driver-token.mjs';
import { StateError } from '../../lib/state.mjs';

export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      const enabled = await sql`select driver_key as "driverKey", name, phone, updated_at as "updatedAt" from dispatch_driver_codes order by name`;
      return json({ enabled });
    }
    const body = await readPayload(request);
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    if (!name && !phone) throw new StateError('Driver name or phone is required');
    const driverKey = driverKeyFor({ name, phone });
    if (body.action === 'revoke') {
      await sql`delete from dispatch_driver_codes where driver_key = ${driverKey}`;
      return json({ ok: true, revoked: true, driverKey });
    }
    const [driver] = await sql`insert into dispatch_driver_codes (driver_key, name, phone, updated_at)
      values (${driverKey}, ${name}, ${phone}, now())
      on conflict (driver_key) do update set name = excluded.name, phone = excluded.phone, updated_at = now()
      returning driver_key as "driverKey", name, phone`;
    return json({ ok: true, driver });
  } catch (error) { return errorResponse(error); }
}
