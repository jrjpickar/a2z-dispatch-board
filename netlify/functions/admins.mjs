// Admin list on the board.
//   GET  /api/admins -> { admins: [...], bootstrap: [...] }  (any signed-in user)
//   POST /api/admins { action: "add" | "remove", userId }     (senior admins only)
//   POST /api/admins { action: "set_role", userId, role: "user" | "viewer" }  (any admin)
//   POST /api/admins { action: "set_role", userId, role: "blocked" }  (senior admins only; unblocking too)
//   GET  /api/admins also returns { roles: [...] }: everyone given a profile type (default User)
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { logActivity } from '../../lib/activity.mjs';
import { requireSession, requireSenior, requireAdmin, adminRows, roleRows, PROFILE_TYPES, ghlUsers, isBootstrapAdmin, bootstrapAdmins } from '../../lib/session.mjs';

export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      await requireSession(request);
      return json({ admins: await adminRows(sql), bootstrap: bootstrapAdmins(), roles: await roleRows(sql) });
    }
    await authorizeWrite(request);
    const { action, userId, role } = await readPayload(request);
    const id = String(userId || '').trim();
    if (action === 'set_role') {
      // Any admin can switch a non-admin between User (dispatcher) and Viewer (read only).
      // Blocking someone, or unblocking them, is for senior admins only.
      if (!id) throw new StateError('Pick a GHL user.');
      if (!PROFILE_TYPES.includes(role)) throw new StateError('Profile type must be User, Viewer or Blocked.');
      const [current] = await sql`select role from dispatch_user_roles where user_id = ${id}`;
      const needsSenior = role === 'blocked' || current?.role === 'blocked';
      const session = needsSenior
        ? await requireSenior(request, sql).catch(e => { throw e.status === 403 ? new StateError('Only a senior admin can block or unblock people.', 403) : e; })
        : await requireAdmin(request, sql);
      const [isAdmin] = await sql`select 1 as ok from dispatch_admins where user_id = ${id}`;
      const user = (await ghlUsers()).find(u => u.id === id);
      if (isAdmin || (user && isBootstrapAdmin(user))) throw new StateError('Admins keep full access. Revoke admin first to make them a User or Viewer.', 409);
      if (!user) throw new StateError('That GHL user was not found.', 404);
      if (role === 'user') await sql`delete from dispatch_user_roles where user_id = ${id}`;
      else await sql`insert into dispatch_user_roles (user_id, name, email, role, set_by) values (${user.id}, ${user.name}, ${user.email || ''}, ${role}, ${session.name})
        on conflict (user_id) do update set name = excluded.name, email = excluded.email, role = excluded.role, set_by = excluded.set_by, updated_at = now()`;
      await logActivity(sql, session, role === 'blocked' ? 'Blocked access' : role === 'viewer' ? 'Made viewer (read only)' : current?.role === 'blocked' ? 'Unblocked (now a user)' : 'Made user (dispatcher)', user.name, { userId: user.id });
      return json({ ok: true, admins: await adminRows(sql), roles: await roleRows(sql) });
    }
    const session = await requireSenior(request, sql);
    if (!id) throw new StateError('Pick a GHL user.');
    if (action === 'add') {
      const user = (await ghlUsers()).find(u => u.id === id);
      if (!user) throw new StateError('That GHL user was not found.', 404);
      await sql`insert into dispatch_admins (user_id, name, email, added_by) values (${user.id}, ${user.name}, ${user.email || ''}, ${session.name})
        on conflict (user_id) do update set name = excluded.name, email = excluded.email`;
      await sql`delete from dispatch_user_roles where user_id = ${user.id}`; // admins are never viewers
      await logActivity(sql, session, 'Enrolled admin', user.name, { userId: user.id });
    } else if (action === 'remove') {
      const [row] = await sql`select user_id as id, name, email from dispatch_admins where user_id = ${id}`;
      if (row && isBootstrapAdmin(row)) throw new StateError(`${row.name} is a senior admin and can't be revoked.`, 409);
      await sql`delete from dispatch_admins where user_id = ${id}`;
      if (row) await logActivity(sql, session, 'Revoked admin', row.name, { userId: id });
    } else throw new StateError('Unknown admin action');
    return json({ ok: true, admins: await adminRows(sql), roles: await roleRows(sql) });
  } catch (error) { return errorResponse(error); }
}
