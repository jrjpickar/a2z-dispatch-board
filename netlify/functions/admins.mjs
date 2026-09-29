// Admin list on the board.
//   GET  /api/admins -> { admins: [...], bootstrap: [...] }  (any signed-in user)
//   POST /api/admins { action: "add" | "remove", userId }     (admins only)
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { requireSession, requireAdmin, adminRows, ghlUsers, isBootstrapAdmin, bootstrapAdmins } from '../../lib/session.mjs';

export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      await requireSession(request);
      return json({ admins: await adminRows(sql), bootstrap: bootstrapAdmins() });
    }
    authorizeWrite(request);
    const session = await requireAdmin(request, sql);
    const { action, userId } = await readPayload(request);
    const id = String(userId || '').trim();
    if (!id) throw new StateError('Pick a GHL user.');
    if (action === 'add') {
      const user = (await ghlUsers()).find(u => u.id === id);
      if (!user) throw new StateError('That GHL user was not found.', 404);
      await sql`insert into dispatch_admins (user_id, name, email, added_by) values (${user.id}, ${user.name}, ${user.email || ''}, ${session.name})
        on conflict (user_id) do update set name = excluded.name, email = excluded.email`;
    } else if (action === 'remove') {
      const [row] = await sql`select user_id as id, name, email from dispatch_admins where user_id = ${id}`;
      if (row && isBootstrapAdmin(row)) throw new StateError(`${row.name} is a permanent admin and can't be removed.`, 409);
      await sql`delete from dispatch_admins where user_id = ${id}`;
    } else throw new StateError('Unknown admin action');
    return json({ ok: true, admins: await adminRows(sql) });
  } catch (error) { return errorResponse(error); }
}
