// The 6:30 PM daily dispatch itself (background function: up to 15 minutes).
// Started by nightly-dispatch.mjs with a key for that day. Sends each job as it sits:
// its net Make assign / remove runs and, for tomorrow's jobs, the schedule text to
// anyone who hasn't gotten it, one job every 15 seconds (lib/daily-dispatch.mjs).
import { db, ensureSchema } from './db.mjs';
import { runNightly, pacificParts } from '../../lib/daily-dispatch.mjs';
import { nightlyKey } from './nightly-dispatch.mjs';
export default async function handler(request) {
  const { date } = pacificParts();
  if (request.headers.get('x-nightly-key') !== nightlyKey(date)) return new Response('Forbidden', { status: 403 });
  const sql = db(); await ensureSchema(sql);
  const result = await runNightly(sql);
  console.log('Nightly dispatch done', JSON.stringify({ tomorrow: result.tomorrow, jobs: result.jobs.length }));
  await sql`update dispatch_settings set value = value || ${JSON.stringify({ finishedAt: new Date().toISOString(), jobs: result.jobs.length })}::jsonb, updated_at = now() where key = ${'nightly-run:' + date}`;
  return new Response(null, { status: 202 });
}
