// Retired (Nov 2026). This used to run every 5 minutes from about 4 AM to 9 PM and
// woke the Netlify database each time, which kept it from ever sleeping during those
// hours (most of the Netlify bill). Held sends now use held-send-background, and the
// 6:30 PM run sweeps anything left over. No schedule here anymore, so it never runs.
// Safe to delete this file.
export default async function handler() {
  return new Response(null, { status: 204 });
}
