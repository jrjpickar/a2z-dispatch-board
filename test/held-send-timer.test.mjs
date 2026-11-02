import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const real = await import('../netlify/functions/db.mjs');
const pg = new PGlite();
function adapter(engine) {
  const sql = async (strings, ...values) => (await engine.query(strings.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), values)).rows;
  sql.json = v => JSON.stringify(v);
  sql.begin = cb => engine.transaction(tx => cb(adapter(tx)));
  return sql;
}
const sql = adapter(pg);
await real.ensureSchema(sql);
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => sql, ensureSchema: async () => {} } });
const { default: timer } = await import('../netlify/functions/held-send-background.mjs');
const { recordEffect, heldSendKey, startHeldSend } = await import('../lib/effect-queue.mjs');
const { saveState } = await import('../lib/store.mjs');
test.after(() => pg.close());
const call = (effectId, key) => timer(new Request('https://x/.netlify/functions/held-send-background', { method: 'POST', headers: { 'x-held-key': key ?? heldSendKey(effectId) }, body: JSON.stringify({ effectId }) }));

test('held send timer: waits out the undo window, sends once, skips undone rows, needs the key', async () => {
  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{"ok":true}'); };
  try {
    const created = await saveState(sql, 'job', { jobId: 'job-t', expectedVersion: 0, requestId: crypto.randomUUID(), action: 'create', crew: 'Ana' });
    await saveState(sql, 'job', { jobId: 'job-t', expectedVersion: created.record.version, requestId: crypto.randomUUID(), action: 'complete' });
    const [req] = await sql`select request_id from dispatch_requests where result->'record'->>'jobId' = 'job-t' and result->'record'->>'status' = 'completed'`;
    const { effectId } = await recordEffect(sql, { requestId: req.request_id, kind: 'job_stage', payload: { action: 'complete', jobId: 'job-t' }, delayMs: 1500 });
    assert.equal((await call(effectId, 'wrong')).status, 403);
    assert.equal(sent.length, 0);
    const t0 = Date.now();
    assert.equal((await call(effectId)).status, 202);
    assert.ok(Date.now() - t0 >= 1400, 'waited for the undo window');
    assert.equal(sent.length, 1); assert.equal(sent[0].action, 'complete');
    const [row] = await sql`select status from dispatch_effects where effect_id = ${effectId}`;
    assert.equal(row.status, 'confirmed');
    // Running it again (or for an undone row) sends nothing.
    await call(effectId); assert.equal(sent.length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('startHeldSend posts to the background function with the key', async () => {
  const realFetch = globalThis.fetch; const old = process.env.URL; let seen;
  process.env.URL = 'https://board.example';
  globalThis.fetch = async (url, init) => { seen = { url, key: init.headers['x-held-key'], body: JSON.parse(init.body) }; return new Response(null, { status: 202 }); };
  try {
    assert.equal(await startHeldSend('abc'), true);
    assert.equal(seen.url, 'https://board.example/.netlify/functions/held-send-background');
    assert.equal(seen.key, heldSendKey('abc')); assert.equal(seen.body.effectId, 'abc');
  } finally { globalThis.fetch = realFetch; if (old === undefined) delete process.env.URL; else process.env.URL = old; }
});
