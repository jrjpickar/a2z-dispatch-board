// Senior-only settings, stored in dispatch_settings.
//   defaultAssignedUserId: '' = the signed-in user (Book Job default), or a GHL user id
//   defaultMarkupPercent:  number prefilled on the EOD sheet ('' = blank)
//   adminPin:              scrypt hash; works alongside DASHBOARD_ADMIN_PIN
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { StateError } from './state.mjs';

export async function readSettings(sql) {
  const rows = await sql`select key, value, updated_by as "updatedBy", updated_at as "updatedAt" from dispatch_settings`;
  return Object.fromEntries(rows.map(r => [r.key, r]));
}
// What every signed-in dispatcher's browser may see (never the PIN).
export async function publicSettings(sql) {
  const s = await readSettings(sql);
  const markup = s.defaultMarkupPercent?.value;
  return {
    defaultAssignedUserId: String(s.defaultAssignedUserId?.value || ''),
    defaultMarkupPercent: markup === '' || markup == null ? '' : Number(markup)
  };
}
export async function seniorSettings(sql) {
  const s = await readSettings(sql);
  return { ...(await publicSettings(sql)), adminPinSet: !!s.adminPin?.value, envPinSet: !!process.env.DASHBOARD_ADMIN_PIN,
    updated: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { by: v.updatedBy, at: v.updatedAt }])) };
}
async function put(sql, key, value, by) {
  await sql`insert into dispatch_settings (key, value, updated_by, updated_at) values (${key}, ${sql.json(value)}, ${by}, now())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
}
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(String(pin), salt, 32).toString('hex')}`;
}
export function pinMatches(pin, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash || !pin) return false;
  const a = scryptSync(String(pin), salt, 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function storedPinMatches(sql, pin) {
  const s = await readSettings(sql);
  return pinMatches(pin, s.adminPin?.value);
}
// Returns a list of what changed, for the activity log.
export async function saveSettings(sql, input, by) {
  const changed = [];
  if (Object.hasOwn(input, 'defaultAssignedUserId')) {
    const id = String(input.defaultAssignedUserId || '').trim();
    if (id && !/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new StateError('Pick a GHL user for the default Assigned User.');
    await put(sql, 'defaultAssignedUserId', id, by); changed.push('default Assigned User');
  }
  if (Object.hasOwn(input, 'defaultMarkupPercent')) {
    const raw = input.defaultMarkupPercent;
    const value = raw === '' || raw == null ? '' : Number(raw);
    if (value !== '' && (!Number.isFinite(value) || value < 0 || value > 1000)) throw new StateError('Markup must be a number from 0 to 1000.');
    await put(sql, 'defaultMarkupPercent', value, by); changed.push('default markup %');
  }
  if (input.clearAdminPin) { await sql`delete from dispatch_settings where key = 'adminPin'`; changed.push('admin PIN cleared'); }
  else if (input.adminPin) {
    if (String(input.adminPin).length < 4) throw new StateError('Admin PIN needs at least 4 characters.');
    await put(sql, 'adminPin', hashPin(input.adminPin), by); changed.push('admin PIN changed');
  }
  return changed;
}
