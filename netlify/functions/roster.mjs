import { db, ensureSchema } from './db.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
const SOURCES = {
  labor: ['LABOR_ROSTER_WEBHOOK', 'https://hook.us2.make.com/3otyoay8td91lhm4u2yuk3gem4d14ajc'],
  drivers: ['DRIVER_ROSTER_WEBHOOK', 'https://hook.us2.make.com/r46r61b9ocan2mmwsmvhjl7pq15wixao'],
  assets: ['ASSET_ROSTER_WEBHOOK', 'https://hook.us2.make.com/7gar4ap547v85ixdebnon6kkey5unt1f']
};
export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const kind = new URL(request.url).searchParams.get('kind');
    if (!Object.hasOwn(SOURCES, kind)) throw new StateError('Unknown roster');
    const sql = db(); await ensureSchema(sql);
    const data = await sql.begin(async tx => {
      // One Make request per roster per five minutes across all browsers/instances.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`roster:${kind}`}, 0))`;
      const [cached] = await tx`select data, updated_at from dispatch_roster_cache where kind = ${kind}`;
      const ttl = Math.max(30, Math.min(3600, Number(process.env.ROSTER_CACHE_SECONDS) || 300)) * 1000;
      if (cached && Date.now() - new Date(cached.updated_at).getTime() < ttl) return cached.data;
      const [env, fallback] = SOURCES[kind];
      const response = await fetch(process.env[env] || fallback, {
        method: kind === 'assets' ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', ...(process.env.MAKE_API_KEY ? { 'x-make-apikey': process.env.MAKE_API_KEY } : {}) },
        ...(kind === 'assets' ? { body: JSON.stringify({ action: 'refresh', booked: false }) } : {})
      });
      if (!response.ok) throw new Error(`Roster source HTTP ${response.status}`);
      const data = await response.json();
      if (!data || typeof data !== 'object') throw new Error('Roster source must return JSON');
      await tx`insert into dispatch_roster_cache (kind, data) values (${kind}, ${tx.json(data)})
        on conflict (kind) do update set data = excluded.data, updated_at = now()`;
      return data;
    });
    return json(data);
  } catch (error) { return errorResponse(error); }
}
