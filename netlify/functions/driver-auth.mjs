// Public sign-in endpoint for the read-only driver app. A driver enters the
// phone number (or name) and access code a dispatcher generated for them via
// driver-codes.mjs, and gets back a long-lived signed token (see
// lib/driver-token.mjs) that the driver app keeps on that phone.
import { timingSafeEqual } from 'node:crypto';
import { db, ensureSchema } from './db.mjs';
import { json, readPayload, errorResponse } from '../../lib/http.mjs';
import { driverKeyFor, signDriverToken } from '../../lib/driver-token.mjs';
import { StateError } from '../../lib/state.mjs';

export default async function handler(request) {
  try {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const body = await readPayload(request);
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    const code = String(body.code || '').trim().toUpperCase();
    if (!code || (!name && !phone)) throw new StateError('Phone (or name) and access code are required');
    const sql = db(); await ensureSchema(sql);
    const driverKey = driverKeyFor({ name, phone });
    const [row] = await sql`select * from dispatch_driver_codes where driver_key = ${driverKey}`;
    const stored = Buffer.from(String(row?.code || ''));
    const supplied = Buffer.from(code);
    if (!row || stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) {
      throw new StateError('Access code not recognized. Check with dispatch.', 401);
    }
    const token = signDriverToken({ driverKey, name: row.name, phone: row.phone });
    return json({ ok: true, token, name: row.name });
  } catch (error) { return errorResponse(error); }
}
