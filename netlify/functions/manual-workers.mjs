// Workers added by an admin from a GHL contact search.
//   GET  /api/manual-workers -> { workers: [{ contactId, name, phone, email, labor, driver }] }
//   POST /api/manual-workers { action: "add", contactId, labor, driver, fieldApp }   (admins only)
//   POST /api/manual-workers { action: "remove", contactId }                          (admins only)
//   POST /api/manual-workers { action: "hide" | "unhide", contactId?, name, phone }   (admins only)
//        Removes / restores a Make-roster laborer on the board only.
//   GET  /api/manual-workers?contact=<id>                                            (admins) -> GHL first/last name + phone
//   POST /api/manual-workers { action: "edit", contactId, firstName, lastName, phone } (admins only)
//        Saves the name/phone on the GHL contact, then updates the board to match:
//        GHL-added list, Field App access (moves to the new phone), crews on open
//        jobs, drivers on open moves, and clears the roster cache so Make's
//        roster is re-read.
// Added workers show in the crew picker (labor) and/or driver picker (driver)
// next to the Make roster, and "fieldApp: true" also enables Field App sign-in.
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { requireAdmin } from '../../lib/session.mjs';
import { getContact, updateContactNamePhone } from '../../lib/ghl.mjs';
import { driverKeyFor } from '../../lib/driver-token.mjs';
import { logActivity } from '../../lib/activity.mjs';

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
    if (request.method === 'GET') {
      const contact = new URL(request.url).searchParams.get('contact');
      if (contact) {
        await requireAdmin(request, sql);
        try { return json({ ok: true, contact: await getContact(contact) }); }
        catch { throw new StateError('Could not load that contact from GHL.', 502); }
      }
      return json({ workers: await rows(sql), hidden: await hiddenRows(sql) });
    }
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
      await logActivity(sql, session, body.action === 'hide' ? 'Removed laborer from the board' : 'Restored laborer to the board', name || phone, { contactId });
      return json({ ok: true, workers: await rows(sql), hidden: await hiddenRows(sql) });
    }
    const contactId = String(body.contactId || '').trim();
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(contactId)) throw new StateError('Pick a GHL contact.');
    if (body.action === 'edit') return json(await editWorker(sql, session, contactId, body));
    if (body.action === 'remove') {
      const [row] = await sql`delete from dispatch_manual_workers where contact_id = ${contactId} returning name, phone`;
      if (row && body.revokeFieldApp !== false) await sql`delete from dispatch_driver_codes where driver_key = ${driverKeyFor(row)}`;
      if (row) await logActivity(sql, session, 'Removed laborer added from GHL', row.name, { contactId });
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
    await logActivity(sql, session, labor ? 'Added laborer from GHL' : 'Updated worker from GHL', contact.name, { contactId: contact.id, labor, driver, fieldApp: !!fieldApp });
    // Adding someone back from GHL also un-hides them if they'd been removed.
    await sql`delete from dispatch_hidden_workers where worker_key = ${hiddenKey({ contactId: contact.id })} or worker_key = ${driverKeyFor(contact)}`;
    return json({ ok: true, worker: contact, fieldApp, workers: await rows(sql), hidden: await hiddenRows(sql) });
  } catch (error) { return errorResponse(error); }
}

async function editWorker(sql, session, contactId, body) {
  const firstName = String(body.firstName || '').trim().slice(0, 60), lastName = String(body.lastName || '').trim().slice(0, 60);
  if (!firstName) throw new StateError('First name is required.');
  let before;
  try { before = await getContact(contactId); } catch { throw new StateError('Could not load that contact from GHL.', 502); }
  let after;
  try { after = await updateContactNamePhone(contactId, { firstName, lastName, phone: body.phone }); }
  catch (error) {
    if (error.status === 400 && /phone/i.test(error.message)) throw new StateError(error.message, 400);
    throw new StateError(`GHL didn't save the change${error.reason ? ': ' + error.reason : ''}. Nothing was changed.`, 502);
  }
  // Board follows GHL. Everything below is best-effort bookkeeping after GHL saved.
  await sql`update dispatch_manual_workers set name = ${after.name}, phone = ${after.phone} where contact_id = ${contactId}`;
  await sql`update dispatch_hidden_workers set name = ${after.name}, phone = ${after.phone} where contact_id = ${contactId}`;
  const oldKey = driverKeyFor(before), newKey = driverKeyFor(after);
  const [access] = await sql`select 1 as ok from dispatch_driver_codes where driver_key = ${oldKey}`;
  if (access) {
    await sql`delete from dispatch_driver_codes where driver_key = ${oldKey}`;
    await sql`insert into dispatch_driver_codes (driver_key, name, phone, updated_at) values (${newKey}, ${after.name}, ${after.phone}, now())
      on conflict (driver_key) do update set name = excluded.name, phone = excluded.phone, updated_at = now()`;
  }
  const same = w => w && (String(w.id || w.contactId || '') === contactId);
  let jobs = 0, moves = 0;
  for (const row of await sql`select job_id, data from job_shared_state where active = true`) {
    const crew = Array.isArray(row.data?.crew) ? row.data.crew : [];
    if (!crew.some(same)) continue;
    const data = { ...row.data, crew: crew.map(w => same(w) ? { ...w, name: after.name, phone: after.phone } : w) };
    await sql`update job_shared_state set data = ${sql.json(data)}, version = version + 1, updated_at = now() where job_id = ${row.job_id}`;
    jobs++;
  }
  for (const row of await sql`select move_id, data from logistics_move_state`) {
    if (String(row.data?.driverId || '') !== contactId || row.data?.active === false) continue;
    const data = { ...row.data, driverName: after.name, driverPhone: after.phone };
    await sql`update logistics_move_state set data = ${sql.json(data)}, version = version + 1, updated_at = now() where move_id = ${row.move_id}`;
    moves++;
  }
  await sql`delete from dispatch_roster_cache where kind in ('labor', 'drivers')`;
  const changes = [before.name !== after.name ? `name ${before.name} → ${after.name}` : '', before.phone !== after.phone ? `phone ${before.phone || 'none'} → ${after.phone || 'none'}` : ''].filter(Boolean);
  await logActivity(sql, session, 'Edited worker in GHL', after.name, { contactId, changes, jobs, moves });
  return { ok: true, worker: after, changes, jobsUpdated: jobs, movesUpdated: moves, fieldAppMoved: !!access && oldKey !== newKey, workers: await rows(sql), hidden: await hiddenRows(sql) };
}
