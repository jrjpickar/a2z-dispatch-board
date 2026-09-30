// Admin page layout and charts.
//   GET  /api/admin-dashboard              -> { layout, panels, senior }        (admins)
//   GET  /api/admin-dashboard?view=stats   -> chart data, only panels this admin may see
//   POST /api/admin-dashboard { action: "save_layout", layout }                 (senior admins)
//   POST /api/admin-dashboard { action: "reset_layout" }                        (senior admins)
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import { requireAdmin, requireSenior } from '../../lib/session.mjs';
import { PANELS, readLayout, saveLayout, resetLayout, panelAccess } from '../../lib/layout.mjs';
import { dashboardStats } from '../../lib/dashboard-stats.mjs';
import { logActivity } from '../../lib/activity.mjs';

const panelInfo = () => PANELS.map(({ id, title, locked }) => ({ id, title, locked: !!locked }));

export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      const session = await requireAdmin(request, sql);
      const access = await panelAccess(sql, session);
      if (new URL(request.url).searchParams.get('view') === 'stats') return json(await dashboardStats(sql, access.can));
      // Admins get only what they can see; senior admins get the whole layout to edit.
      const layout = access.senior ? access.layout : { panels: access.layout.panels.filter(p => access.can(p.id)), updated: access.layout.updated };
      return json({ layout, panels: panelInfo(), senior: access.senior });
    }
    authorizeWrite(request);
    const session = await requireSenior(request, sql);
    const body = await readPayload(request);
    if (body.action === 'save_layout') {
      await saveLayout(sql, body.layout, session.name);
      await logActivity(sql, session, 'Changed the admin page layout');
    } else if (body.action === 'reset_layout') {
      await resetLayout(sql);
      await logActivity(sql, session, 'Reset the admin page layout');
    } else throw new StateError('Unknown action');
    return json({ ok: true, layout: await readLayout(sql), panels: panelInfo(), senior: true });
  } catch (error) { return errorResponse(error); }
}
