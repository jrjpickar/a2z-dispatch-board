// Field app sign in activity (Admin > Field App Access).
// Every sign in try is kept (signed in, or refused because the phone isn't enabled), and
// each enabled worker's "last opened" time is updated when the app loads their jobs
// (at most once every 10 minutes, so it costs next to nothing).
export function deviceOf(request) {
  const ua = String(request.headers.get('user-agent') || '');
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'Computer';
  return ua ? 'Other' : '';
}
export async function recordSignin(sql, { driverKey = '', name = '', phone = '', ok, reason = '', device = '' }) {
  try {
    await sql`insert into field_app_signins (driver_key, name, phone, ok, reason, device)
      values (${String(driverKey).slice(0, 120)}, ${String(name).slice(0, 120)}, ${String(phone).slice(0, 40)}, ${!!ok}, ${String(reason).slice(0, 200)}, ${String(device).slice(0, 40)})`;
    if (ok && driverKey) await sql`update dispatch_driver_codes set last_signin_at = now(), last_seen_at = now() where driver_key = ${driverKey}`;
  } catch (error) { console.error('Field app sign in log failed', error); } // never blocks the sign in
}
export async function touchSeen(sql, driverKey) {
  try { await sql`update dispatch_driver_codes set last_seen_at = now() where driver_key = ${String(driverKey)} and (last_seen_at is null or last_seen_at < now() - interval '10 minutes')`; }
  catch (error) { console.error('Field app last seen failed', error); }
}
export async function recentSignins(sql, limit = 100) {
  return sql`select id, at, driver_key as "driverKey", name, phone, ok, reason, device from field_app_signins order by at desc, id desc limit ${limit}`;
}
