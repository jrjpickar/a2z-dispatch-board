// GHL jobs are cached in Postgres across instances. On each warm instance,
// overlapping ordinary board opens also share one pending load, so a cache miss
// does not start the same five GHL searches for every browser. A forced refresh
// always starts its own read, including after a dispatcher's save.
const pendingLoads = new WeakMap();
export function cachedGhlJobs(sql, fresh, load) {
  if (fresh) return readOrLoad(sql, true, load);
  if (pendingLoads.has(sql)) return pendingLoads.get(sql);
  const pending = readOrLoad(sql, false, load).finally(() => {
    if (pendingLoads.get(sql) === pending) pendingLoads.delete(sql);
  });
  pendingLoads.set(sql, pending);
  return pending;
}
async function readOrLoad(sql, fresh, load) {
  const ttl = Math.max(0, Math.min(600, Number(process.env.DASHBOARD_CACHE_SECONDS ?? 60) || 0)) * 1000;
  if (!fresh && ttl) {
    const [cached] = await sql`select data, updated_at from dispatch_feed_cache where key = 'ghl-jobs'`;
    const data = cached && (typeof cached.data === 'string' ? JSON.parse(cached.data) : cached.data);
    if (Array.isArray(data) && Date.now() - new Date(cached.updated_at).getTime() < ttl) return data;
  }
  const jobs = await load();
  await sql`insert into dispatch_feed_cache (key, data, updated_at) values ('ghl-jobs', ${sql.json(jobs)}, now())
    on conflict (key) do update set data = excluded.data, updated_at = now()`;
  return jobs;
}
