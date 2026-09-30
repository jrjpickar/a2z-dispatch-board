// Admin page layout: one shared layout a senior admin arranges for every admin.
// Stored in dispatch_settings under "adminLayout":
//   { panels: [{ id, w, h, hidden, audience }] }   (array order = page order)
//   w: width in 12-column grid units (3-12)
//   h: fixed height in px (0 = fit content)
//   hidden: off for everyone until a senior admin shows it again
//   audience: 'all' = every admin, 'senior' = senior admins only
// Audience is enforced on the server (see requirePanel and the senior/stat views),
// not just hidden in the page.
import { StateError } from './state.mjs';
import { requireAdmin, isBootstrapAdmin } from './session.mjs';

// locked: always senior only (the senior settings form holds the admin PIN).
export const PANELS = [
  { id: 'admins', title: 'Admins', w: 6, audience: 'all' },
  { id: 'laborers', title: 'Laborers', w: 6, audience: 'all' },
  { id: 'chartJobs', title: 'Jobs on site per day', w: 6, audience: 'all' },
  { id: 'chartCrew', title: 'Crew booked per day', w: 6, audience: 'all' },
  { id: 'fieldApp', title: 'Field App Access', w: 12, audience: 'all' },
  { id: 'chartValue', title: 'Job value by week', w: 6, audience: 'senior' },
  { id: 'chartHealth', title: 'Make run health', w: 6, audience: 'senior' },
  { id: 'problems', title: 'Make / GHL problems', w: 6, audience: 'senior' },
  { id: 'settings', title: 'Settings', w: 6, audience: 'senior', locked: true },
  { id: 'activity', title: 'Activity log', w: 6, audience: 'senior' },
  { id: 'history', title: 'Send history', w: 6, audience: 'senior' }
];
const BY_ID = new Map(PANELS.map(p => [p.id, p]));
const KEY = 'adminLayout';

export function defaultLayout() {
  return { panels: PANELS.map(p => ({ id: p.id, w: p.w, h: 0, hidden: false, audience: p.audience })) };
}

// Accepts whatever the page sends; returns a complete, valid layout. Unknown ids
// are dropped, duplicates ignored, and panels added in a later release are
// appended with their defaults so they never go missing.
export function normalizeLayout(input) {
  const list = Array.isArray(input?.panels) ? input.panels : [];
  const seen = new Set(), panels = [];
  for (const raw of list) {
    const def = BY_ID.get(String(raw?.id || ''));
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    const w = Math.round(Number(raw.w));
    const h = Math.round(Number(raw.h));
    panels.push({
      id: def.id,
      w: Number.isFinite(w) ? Math.min(12, Math.max(3, w)) : def.w,
      h: Number.isFinite(h) && h >= 120 ? Math.min(1600, h) : 0,
      hidden: raw.hidden === true,
      audience: def.locked ? 'senior' : raw.audience === 'senior' ? 'senior' : raw.audience === 'all' ? 'all' : def.audience
    });
  }
  for (const def of PANELS) if (!seen.has(def.id)) panels.push({ id: def.id, w: def.w, h: 0, hidden: false, audience: def.audience });
  return { panels };
}

export async function readLayout(sql) {
  const [row] = await sql`select value, updated_by as "by", updated_at as "at" from dispatch_settings where key = ${KEY}`;
  return { ...normalizeLayout(row?.value || defaultLayout()), updated: row ? { by: row.by, at: row.at } : null };
}
export async function saveLayout(sql, input, by) {
  const layout = normalizeLayout(input);
  await sql`insert into dispatch_settings (key, value, updated_by, updated_at) values (${KEY}, ${sql.json(layout)}, ${by}, now())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
  return layout;
}
export async function resetLayout(sql) {
  await sql`delete from dispatch_settings where key = ${KEY}`;
}

// Hidden panels stay reachable by their API; only the audience setting limits who can use them.
export function canSee(layout, panelId, senior) {
  if (senior) return true;
  const p = layout.panels.find(x => x.id === panelId);
  return !!p && p.audience === 'all';
}
export async function panelAccess(sql, session) {
  const senior = isBootstrapAdmin(session);
  const layout = await readLayout(sql);
  return { senior, layout, can: id => canSee(layout, id, senior) };
}
// requireAdmin, plus: a senior admin hasn't limited this panel to senior admins.
export async function requirePanel(request, sql, panelId) {
  const session = await requireAdmin(request, sql);
  const { can } = await panelAccess(sql, session);
  if (!can(panelId)) throw new StateError(`A senior admin has limited ${BY_ID.get(panelId)?.title || 'this'} to senior admins.`, 403);
  return session;
}
