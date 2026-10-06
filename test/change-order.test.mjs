import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureSchema } from '../netlify/functions/db.mjs';
import { saveState } from '../lib/store.mjs';
import { mutateJob } from '../lib/state.mjs';
import { linkChangeOrder, unlinkChangeOrder } from '../lib/change-order.mjs';
const pg = new PGlite();
function adapter(engine) {
  const sql = async (strings, ...values) => {
    const query = strings.reduce((text, part, i) => text + (i ? '$' + i : '') + part, '');
    return (await engine.query(query, values)).rows;
  };
  sql.json = value => JSON.stringify(value);
  sql.begin = callback => engine.transaction(tx => callback(adapter(tx)));
  return sql;
}
const sql = adapter(pg);
await ensureSchema(sql);
const req = (jobId, body) => ({ jobId, requestId: crypto.randomUUID(), ...body });
const session = { uid: 'u1', name: 'Jesse Pickar' };
const version = async id => Number((await sql`select version from job_shared_state where job_id = ${id}`)[0]?.version || 0);

test('link and unlink keep crew, times and details', () => {
  const job = { version: 2, active: true, data: { crew: [{ name: 'Ana', id: 'a', phone: '' }], reportDate: '2026-10-07', scopeOfWork: 'Keep' } };
  const linked = mutateJob(job, { action: 'link_change_order', jobId: 'co1', parentJobId: 'p1', parentJobName: '1 Main St', linkedBy: 'Jesse', crew: [] });
  assert.equal(linked.data.parentJobId, 'p1'); assert.equal(linked.data.parentJobName, '1 Main St'); assert.equal(linked.data.changeOrderLinkedBy, 'Jesse');
  assert.equal(linked.data.crew.length, 1); assert.equal(linked.data.scopeOfWork, 'Keep');
  const unlinked = mutateJob({ ...job, data: linked.data }, { action: 'unlink_change_order' });
  assert.equal(unlinked.data.parentJobId, undefined); assert.equal(unlinked.data.reportDate, '2026-10-07');
  assert.throws(() => mutateJob(job, { action: 'link_change_order', jobId: 'p1', parentJobId: 'p1' }), /itself/);
  assert.throws(() => mutateJob(job, { action: 'link_change_order', jobId: 'co1' }), /parent/);
});

test('linking moves the job in GHL first, then saves the link and logs it', async () => {
  const moved = [];
  const move = async id => { moved.push(id); return { status: 'moved' }; };
  const result = await linkChangeOrder(sql, req('co-a', { expectedVersion: 0, parentJobId: 'parent-a', parentJobName: '1 Main St', changeOrderName: '1 Main St extra' }), session, { move });
  assert.deepEqual(moved, ['co-a']);
  assert.equal(result.record.parentJobId, 'parent-a'); assert.equal(result.record.changeOrderLinkedBy, 'Jesse Pickar'); assert.equal(result.ghlMove.status, 'moved');
  const [log] = await sql`select action, target from dispatch_activity where action = 'Linked change order'`;
  assert.match(log.target, /1 Main St extra to 1 Main St/);
});

test('if GHL refuses the move, nothing is linked', async () => {
  const move = async () => { throw Object.assign(new Error('GHL HTTP 422'), { reason: 'stage invalid' }); };
  await assert.rejects(linkChangeOrder(sql, req('co-b', { expectedVersion: 0, parentJobId: 'parent-a' }), session, { move }), e => e.status === 502 && /nothing was linked/.test(e.message));
  assert.equal(await version('co-b'), 0);
});

test('no nesting: a change order cannot be a parent, and a parent cannot become a change order', async () => {
  const move = async () => { throw new Error('should not be called'); };
  await assert.rejects(linkChangeOrder(sql, req('co-c', { expectedVersion: 0, parentJobId: 'co-a' }), session, { move }), /itself a change order/);
  await assert.rejects(linkChangeOrder(sql, req('parent-a', { expectedVersion: 0, parentJobId: 'other' }), session, { move }), /Other change orders/);
  await assert.rejects(linkChangeOrder(sql, req('co-a', { expectedVersion: 0, parentJobId: 'co-a' }), session, { move }), /itself/);
});

test('a stale version is refused before GHL is touched', async () => {
  let called = false;
  await assert.rejects(linkChangeOrder(sql, req('co-a', { expectedVersion: 0, parentJobId: 'parent-z' }), session, { move: async () => { called = true; } }), e => e.status === 409);
  assert.equal(called, false);
});

test('closed jobs cannot be linked', async () => {
  await saveState(sql, 'job', req('co-closed', { expectedVersion: 0, action: 'complete' }));
  await assert.rejects(linkChangeOrder(sql, req('co-closed', { expectedVersion: 1, parentJobId: 'parent-a' }), session, { move: async () => ({}) }), /closed/);
});

test('changing the parent and unlinking', async () => {
  const relinked = await linkChangeOrder(sql, req('co-a', { expectedVersion: await version('co-a'), parentJobId: 'parent-b', parentJobName: '9 Oak Ave' }), session, { move: async () => ({ status: 'already' }) });
  assert.equal(relinked.record.parentJobId, 'parent-b');
  const unlinked = await unlinkChangeOrder(sql, req('co-a', { expectedVersion: relinked.record.version, parentJobId: 'parent-b' }), session);
  assert.equal(unlinked.record.parentJobId, undefined);
});

test('GHL move: uses the first Change Order stage, keeps status won, and skips jobs already there', async () => {
  const { moveToChangeOrderPipeline } = await import('../lib/ghl.mjs');
  process.env.GHL_API_TOKEN = 'test'; delete process.env.CHANGE_ORDER_STAGE_ID;
  const calls = []; const realFetch = globalThis.fetch;
  let pipelineId = 'labor';
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const body = String(url).includes('/opportunities/pipelines')
      ? { pipelines: [{ id: 'Nvk3EKhRzg5omo4BLCOK', stages: [{ id: 's2', position: 1 }, { id: 's1', position: 0 }] }] }
      : { opportunity: { id: 'opp1', pipelineId, pipelineStageId: 'x' } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const moved = await moveToChangeOrderPipeline('opp1');
    assert.equal(moved.status, 'moved');
    const put = calls.find(c => c.method === 'PUT');
    assert.deepEqual(put.body, { pipelineId: 'Nvk3EKhRzg5omo4BLCOK', pipelineStageId: 's1', status: 'won' });
    calls.length = 0; pipelineId = 'Nvk3EKhRzg5omo4BLCOK';
    assert.equal((await moveToChangeOrderPipeline('opp1')).status, 'already');
    assert.equal(calls.some(c => c.method === 'PUT'), false);
  } finally { globalThis.fetch = realFetch; }
});
