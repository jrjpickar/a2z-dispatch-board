// Dashboard sign-in (see lib/session.mjs).
//   GET  /api/session                      -> { signedIn, user, isAdmin, needsAdminUnlock }
//   POST /api/session { action: "ghl", encryptedData }   (GHL Custom Page REQUEST_USER_DATA)
//   POST /api/session { action: "signin", source: "picker", userId, pin? }
//   POST /api/session { action: "unlock", pin }     (admin PIN for this browser)
//   POST /api/session { action: "signout" }
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import {
  sessionFromRequest, sessionInfo, signSession, sessionCookie, clearSessionCookie, ghlUsers, matchUser,
  isBootstrapAdmin, secretMatches, ghlUserFromContext
} from '../../lib/session.mjs';

export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') return json(await sessionInfo(sql, sessionFromRequest(request)));
    authorizeWrite(request);
    const body = await readPayload(request);
    if (body.action === 'signout') return json({ ok: true, signedIn: false }, 200, { 'set-cookie': clearSessionCookie() });

    let user, via;
    if (body.action === 'ghl') {
      user = ghlUserFromContext(body.encryptedData);
      // Prefer the name as it is on the GHL user list (same as the Assigned User list).
      try { const listed = (await ghlUsers()).find(u => u.id === user.id); if (listed) user = { ...user, name: listed.name }; } catch {}
      via = 'ghl_sso';
    } else if (body.action === 'unlock') {
      const current = sessionFromRequest(request);
      if (!current) throw new StateError('Sign in first.', 401);
      if (!secretMatches(body.pin, process.env.DASHBOARD_ADMIN_PIN)) throw new StateError(process.env.DASHBOARD_ADMIN_PIN ? 'That admin PIN is not right.' : 'No DASHBOARD_ADMIN_PIN is set in Netlify. Open the board inside GHL instead.', 403);
      user = { id: current.uid, name: current.name, email: current.email }; via = 'pin';
    } else if (body.action === 'signin') {
      let users;
      try { users = await ghlUsers({ fresh: true }); }
      catch { throw new StateError('Could not load the GHL user list to sign you in. Try again in a minute.', 502); }
      user = matchUser(users, { userId: body.userId });
      if (!user) throw new StateError('Pick your name from the list.', 401);
      via = body.pin && secretMatches(body.pin, process.env.DASHBOARD_ADMIN_PIN) ? 'pin' : 'picker';
    } else throw new StateError('Unknown session action');

    // Keep the bootstrap admin (Jesse Pickar) on the admin list so it shows up there.
    if (isBootstrapAdmin(user)) await sql`insert into dispatch_admins (user_id, name, email, added_by)
      values (${user.id}, ${user.name}, ${user.email || ''}, 'bootstrap') on conflict (user_id) do update set name = excluded.name, email = excluded.email`;
    const token = signSession(user, via);
    const info = await sessionInfo(sql, { uid: user.id, name: user.name, email: user.email, via });
    return json({ ok: true, token, ...info }, 200, { 'set-cookie': sessionCookie(token) });
  } catch (error) { return errorResponse(error); }
}
