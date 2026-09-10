// Public sign-in endpoint for the read-only field app. A driver or crew
// member enters the phone number (or name, if no phone is on file) that a
// dispatcher enabled for them via driver-codes.mjs, and gets back a
// long-lived signed token (see lib/driver-token.mjs) that the app keeps on
// that phone. No access code -- being on the enabled list is the whole gate.
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
    if (!name && !phone) throw new StateError('Enter your phone number to sign in.');
    const sql = db(); await ensureSchema(sql);
    const driverKey = driverKeyFor({ name, phone });
    const [row] = await sql`select * from dispatch_driver_codes where driver_key = ${driverKey}`;
    if (!row) throw new StateError("That phone number isn't enabled yet. Check with dispatch.", 401);
    const token = signDriverToken({ driverKey, name: row.name, phone: row.phone });
    return json({ ok: true, token, name: row.name });
  } catch (error) { return errorResponse(error); }
}
