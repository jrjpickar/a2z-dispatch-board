import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
const { default: dashboard } = await import('../netlify/functions/dashboard-data.mjs');
const { default: shared } = await import('../netlify/functions/shared-state.mjs');
const sql = adapter(pg);
await real.ensureSchema(sql);
const LABOR_STAGE = 'b3ba7011-5b50-48b1-986d-fed4281289f6';
const put = (id, active, data = {}) => sql`insert into job_shared_state (job_id, data, active) values (${id}, ${JSON.stringify({ jobId: id, ...data })}, ${active})`;
await put('open1', true); await put('live1', false, { status: 'completed' }); await put('old1', false, { status: 'completed' });
await put('co1', false, { status: 'completed', parentJobId: 'live1' });

test('board feed: active stages only, lean shared state, shared cache, Refresh skips it, Completed loads on its own', async () => {
  process.env.GHL_API_TOKEN = 'x';
  const urls = [];
  globalThis.fetch = async u => {
    u = new URL(String(u)); urls.push(u);
    const stage = u.searchParams.get('pipeline_stage_id');
    const opportunities = stage === LABOR_STAGE ? [{ id: 'open1', pipelineStageId: LABOR_STAGE }, { id: 'live1', pipelineStageId: LABOR_STAGE }] : [];
    return Response.json({ opportunities, meta: { total: opportunities.length } });
  };
  const first = await (await dashboard(new Request('http://x/api/dashboard-data'))).json();
  assert.deepEqual(first.jobs.map(j => j.id).sort(), ['live1', 'open1']);
  assert.deepEqual(first.sharedState.map(r => r.jobId).sort(), ['co1', 'live1', 'open1'], 'old closed jobs stay out of the board feed');
  assert.ok(first.serverTime);
  assert.equal(urls.length, 5, 'one search per active labor/demo stage + change orders');
  assert.ok(urls.filter(u => u.searchParams.get('pipeline_stage_id')).length === 4);

  await dashboard(new Request('http://x/api/dashboard-data'));
  assert.equal(urls.length, 5, 'second open within the cache window does not call GHL');
  await dashboard(new Request('http://x/api/dashboard-data?fresh=1'));
  assert.equal(urls.length, 10, 'Refresh (fresh=1) pulls GHL again');

  const closed = await (await shared(new Request('http://x/api/shared-state?view=closed'))).json();
  assert.deepEqual(closed.sharedState.map(r => r.jobId).sort(), ['co1', 'live1', 'old1']);
});
