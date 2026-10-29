import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedGhlJobs } from '../lib/feed-cache.mjs';
function fakeSql(cached) {
  const sql = async strings => strings[0].startsWith('select') ? (cached ? [cached] : []) : [];
  sql.json = JSON.stringify;
  return sql;
}
test('overlapping board opens share one cache miss and failed loads can retry', async () => {
  const sql = fakeSql();
  let calls = 0, finish;
  const load = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = cachedGhlJobs(sql, false, load), second = cachedGhlJobs(sql, false, load);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish([{ id: 'j1' }]);
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
  await assert.rejects(cachedGhlJobs(sql, false, async () => { throw Error('GHL unavailable'); }), /GHL unavailable/);
  assert.deepEqual(await cachedGhlJobs(sql, false, async () => []), []);
});
test('fresh after a save never reuses an older in-flight board read', async () => {
  const sql = fakeSql(); let finish;
  const old = cachedGhlJobs(sql, false, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  const fresh = await cachedGhlJobs(sql, true, async () => [{ id: 'new' }]);
  assert.equal(fresh[0].id, 'new');
  finish([{ id: 'old' }]); await old;
});
test('fresh bypasses the shared cache while ordinary loads reuse it', async () => {
  const sql = fakeSql({ data: [{ id: 'cached' }], updated_at: new Date() });
  assert.equal((await cachedGhlJobs(sql, false, () => assert.fail('cached jobs should be reused')))[0].id, 'cached');
  assert.equal((await cachedGhlJobs(sql, true, async () => [{ id: 'fresh' }]))[0].id, 'fresh');
});
