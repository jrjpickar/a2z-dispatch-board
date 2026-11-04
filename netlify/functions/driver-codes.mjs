// Admins only (since 1.8): enable/revoke. Anyone signed in can view.
// Enable/view/revoke who is allowed to sign in to the
// read-only field app. Same trust model as the rest of the board (same-origin
// write) -- see lib/http.mjs authorizeWrite. No access code involved anymore:
// being on this enabled list, plus knowing your own phone number, is the
// whole login (see driver-auth.mjs).
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { driverKeyFor } from '../../lib/driver-token.mjs';
import { StateError } from '../../lib/state.mjs';
import { requirePanel } from '../../lib/layout.mjs';
import { logActivity } from '../../lib/activity.mjs';
import { recentSignins } from '../../lib/field-signins.mjs';

export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      // ?view=signins: field app sign in activity (admins who can see Field App Access).
      if (new URL(request.url).searchParams.get('view') === 'signins') {
        await requirePanel(request, sql, 'fieldApp');
        return json({ signins: await recentSignins(sql, 100) });
      }
      const enabled = await sql`select driver_key as "driverKey", name, phone, updated_at as "updatedAt", last_signin_at as "lastSigninAt", last_seen_at as "lastSeenAt" from dispatch_driver_codes order by name`;
      return json({ enabled });
    }
    const session = await requirePanel(request, sql, 'fieldApp');
    const body = await readPayload(request);
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    if (!name && !phone) throw new StateError('Driver name or phone is required');
    const driverKey = driverKeyFor({ name, phone });
    if (body.action === 'revoke') {
      await sql`delete from dispatch_driver_codes where driver_key = ${driverKey}`;
      await logActivity(sql, session, 'Revoked Field App access', name || phone);
      return json({ ok: true, revoked: true, driverKey });
    }
    const [driver] = await sql`insert into dispatch_driver_codes (driver_key, name, phone, updated_at)
      values (${driverKey}, ${name}, ${phone}, now())
      on conflict (driver_key) do update set name = excluded.name, phone = excluded.phone, updated_at = now()
      returning driver_key as "driverKey", name, phone`;
    await logActivity(sql, session, 'Enabled Field App access', name || phone);
    return json({ ok: true, driver });
  } catch (error) { return errorResponse(error); }
}
