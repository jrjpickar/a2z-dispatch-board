// Workers added by an admin from a GHL contact search.
//   GET  /api/manual-workers -> { workers: [{ contactId, name, phone, email, labor, driver }] }
//   POST /api/manual-workers { action: "add", contactId, labor, driver, fieldApp }   (admins only)
//   POST /api/manual-workers { action: "remove", contactId }                          (admins only)
//   POST /api/manual-workers { action: "hide" | "unhide", contactId?, name, phone }   (admins only)
//        Removes / restores a Make-roster laborer on the board only.
// Added workers show in the crew picker (labor) and/or driver picker (driver)
// next to the Make roster, and "fieldApp: true" also enables Field App sign-in.
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { requireAdmin } from '../../lib/session.mjs';
import { getContact } from '../../lib/ghl.mjs';
import { driverKeyFor } from '../../lib/driver-token.mjs';

const hiddenKey = ({ contactId, phone, name }) => {
  const id = String(contactId || '').trim();
  return id ? `id:${id}` : driverKeyFor({ phone, name });
};
const hiddenRows = sql => sql`select worker_key as "key", role, name, phone, contact_id as "contactId", hidden_by as "hiddenBy", created_at as "createdAt"
  from dispatch_hidden_workers order by name`;
const rows = sql => sql`select contact_id as "contactId", name, phone, email, is_labor as labor, is_driver as driver, added_by as "addedBy", created_at as "createdAt"
  from dispatch_manual_workers order by name`;

export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') return json({ workers: await rows(sql), hidden: await hiddenRows(sql) });
    authorizeWrite(request);
    const session = await requireAdmin(request, sql);
    const body = await readPayload(request);
    if (body.action === 'hide' || body.action === 'unhide') {
      const name = String(body.name || '').trim().slice(0, 120), phone = String(body.phone || '').trim().slice(0, 30);
      const contactId = String(body.contactId || '').trim().slice(0, 80);
      if (!name && !phone && !contactId) throw new StateError('Worker name or phone is required.');
      const key = body.key ? String(body.key) : hiddenKey({ contactId, phone, name });
      if (body.action === 'hide') await sql`insert into dispatch_hidden_workers (worker_key, role, name, phone, contact_id, hidden_by)
        values (${key}, 'labor', ${name}, ${phone}, ${contactId}, ${session.name}) on conflict (worker_key) do nothing`;
      else await sql`delete from dispatch_hidden_workers where worker_key = ${key}`;
      return json({ ok: true, workers: await rows(sql), hidden: await hiddenRows(sql) });
    }
    const contactId = String(body.contactId || '').trim();
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(contactId)) throw new StateError('Pick a GHL contact.');
    if (body.action === 'remove') {
      const [row] = await sql`delete from dispatch_manual_workers where contact_id = ${contactId} returning name, phone`;
      if (row && body.revokeFieldApp !== false) await sql`delete from dispatch_driver_codes where driver_key = ${driverKeyFor(row)}`;
      return json({ ok: true, workers: await rows(sql), hidden: await hiddenRows(sql) });
    }
    if (body.action !== 'add') throw new StateError('Unknown action');
    // Always take name/phone from GHL itself, not from the browser.
    let contact;
    try { contact = await getContact(contactId); }
    catch { throw new StateError('Could not load that contact from GHL.', 502); }
    const labor = body.labor !== false, driver = body.driver === true;
    if (!labor && !driver) throw new StateError('Choose Crew, Driver or both.');
    if (body.fieldApp !== false && !contact.phone) throw new StateError(`${contact.name} has no phone number in GHL. Add one there first (the Field App signs in by phone).`);
    await sql`insert into dispatch_manual_workers (contact_id, name, phone, email, is_labor, is_driver, added_by)
      values (${contact.id}, ${contact.name}, ${contact.phone}, ${contact.email}, ${labor}, ${driver}, ${session.name})
      on conflict (contact_id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email,
        is_labor = excluded.is_labor, is_driver = excluded.is_driver`;
    let fieldApp = null;
    if (body.fieldApp !== false) {
      const driverKey = driverKeyFor(contact);
      [fieldApp] = await sql`insert into dispatch_driver_codes (driver_key, name, phone, updated_at) values (${driverKey}, ${contact.name}, ${contact.phone}, now())
        on conflict (driver_key) do update set name = excluded.name, phone = excluded.phone, updated_at = now()
        returning driver_key as "driverKey", name, phone`;
    }
    // Adding someone back from GHL also un-hides them if they'd been removed.
    await sql`delete from dispatch_hidden_workers where worker_key = ${hiddenKey({ contactId: contact.id })} or worker_key = ${driverKeyFor(contact)}`;
    return json({ ok: true, worker: contact, fieldApp, workers: await rows(sql), hidden: await hiddenRows(sql) });
  } catch (error) { return errorResponse(error); }
}
