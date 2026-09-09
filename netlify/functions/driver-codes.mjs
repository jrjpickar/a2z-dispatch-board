// Dispatcher-only: generate/view/revoke the short access codes drivers use to
// sign in to the read-only driver app. Same trust model as the rest of the
// board (same-origin write) -- see lib/http.mjs authorizeWrite.
import { randomInt } from 'node:crypto';
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { driverKeyFor } from '../../lib/driver-token.mjs';
import { StateError } from '../../lib/state.mjs';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L, easy to read aloud
function generateCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      const codes = await sql`select driver_key as "driverKey", name, phone, code, updated_at as "updatedAt" from dispatch_driver_codes order by name`;
      return json({ codes });
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
    const code = generateCode();
    const [driver] = await sql`insert into dispatch_driver_codes (driver_key, name, phone, code, updated_at)
      values (${driverKey}, ${name}, ${phone}, ${code}, now())
      on conflict (driver_key) do update set name = excluded.name, phone = excluded.phone, code = excluded.code, updated_at = now()
      returning driver_key as "driverKey", name, phone, code`;
    return json({ ok: true, driver });
  } catch (error) { return errorResponse(error); }
}
