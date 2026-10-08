import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
const { default: handler } = await import('../netlify/functions/worker-temperatures.mjs');
test('slices, pending, phone lookup', async () => {
  process.env.GHL_API_TOKEN = 'x';
  let calls = 0;
  globalThis.fetch = async u => { calls++; u = String(u); await new Promise(r => setTimeout(r, 400));
    if (u.includes('/search/duplicate')) return Response.json({ contact: { id: 'cPhone' } });
    const id = u.split('/contacts/')[1];
    return Response.json({ contact: { id, customFields: [{ id: 'xOi9gCcAt2UvgA6POHMB', value: id === 'cPhone' ? 'Warm' : 'Hot' }] } }); };
  const ids = Array.from({ length: 90 }, (_, i) => 'c' + i);
  let pending = ids, phones = ['(714) 555-0100'], all = {}, rounds = 0;
  while (pending.length || phones.length) {
    const r = await handler(new Request('http://x/api/worker-temperatures?' + new URLSearchParams({ ids: pending.join(','), phones: phones.join(',') })));
    const d = await r.json(); rounds++;
    Object.assign(all, d.temperatures);
    pending = d.pending.filter(k => !k.startsWith('phone:')); phones = d.pending.filter(k => k.startsWith('phone:')).map(k => k.slice(6));
  }
  assert.ok(rounds > 1, 'needed several slices');
  assert.equal(ids.filter(id => all[id] === 'Hot').length, 90);
  assert.equal(all['phone:7145550100'], 'Warm');
  const before = calls;
  const d = await (await handler(new Request('http://x/api/worker-temperatures?ids=' + ids.join(',')))).json();
  assert.equal(calls, before, 'served from cache'); assert.equal(d.pending.length, 0);
});
