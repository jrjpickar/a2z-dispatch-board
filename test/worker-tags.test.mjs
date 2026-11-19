import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
process.env.SESSION_SECRET = 'test-secret'; process.env.GHL_API_TOKEN = 'x';
const { signSession } = await import('../lib/session.mjs');
const { cleanTags, cleanWorkers } = await import('../lib/worker-tags.mjs');
const { default: handler } = await import('../netlify/functions/worker-tags.mjs');
const sql = adapter(pg);
const jesse = { id: 'uJessePickar01', name: 'Jesse Pickar', email: 'jesse@a2zcs.net' };
const req = (method, body) => new Request('https://board.test/api/worker-tags', { method, ...(body ? { body: JSON.stringify(body) } : {}),
  headers: { 'content-type': 'application/json', origin: 'https://board.test', 'x-a2z-session': signSession(jesse, 'ghl_sso') } });
let tagged;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  let m = url.match(/\/contacts\/([^/?]+)\/tags$/);
  if (m && init.method === 'POST') {
    if (m[1] === 'cGone') return Response.json({ message: 'Contact not found' }, { status: 404 });
    tagged.push({ id: m[1], tags: JSON.parse(init.body).tags }); return Response.json({ tags: JSON.parse(init.body).tags });
  }
  if (url.includes('/contacts/search/duplicate')) return Response.json(url.includes('5550000003') ? { contact: { id: 'cByPhone' } } : {});
  if (url.includes('/locations/') && url.endsWith('/tags')) return Response.json({ tags: [{ name: 'forklift cert' }, { name: 'Bilingual' }, { name: 'forklift cert' }] });
  throw new Error('unexpected fetch ' + url);
};

test('cleanTags and cleanWorkers', () => {
  assert.deepEqual(cleanTags(' Forklift  Cert , forklift cert,,OSHA 10 '), ['forklift cert', 'osha 10']);
  assert.equal(cleanTags(Array.from({ length: 20 }, (_, i) => 't' + i)).length, 10);
  assert.deepEqual(cleanWorkers([{ contactId: 'c1', name: 'A' }, { contactId: 'c1' }, { phone: '(555) 000-0003', name: 'B' }, { name: 'nobody' }, { contactId: 'bad id!' }]).map(w => w.key),
    ['id:c1', 'phone:5550000003']);
});

test('GET lists the location tags', async () => {
  const data = await (await handler(req('GET'))).json();
  assert.deepEqual(data.tags, ['Bilingual', 'forklift cert']);
});

test('POST tags by id, finds by phone, reports misses, logs activity', async () => {
  tagged = [];
  await real.ensureSchema(sql);
  const res = await handler(req('POST', { tags: ['Forklift Cert', 'osha 10'], workers: [
    { contactId: 'c1', name: 'Ana Lopez' }, { phone: '+15550000003', name: 'Juan Diaz' }, { phone: '+15550000009', name: 'No Contact' }, { contactId: 'cGone', name: 'Gone' }] }));
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.deepEqual(tagged, [{ id: 'c1', tags: ['forklift cert', 'osha 10'] }, { id: 'cByPhone', tags: ['forklift cert', 'osha 10'] }]);
  assert.deepEqual(data.added.map(a => a.name), ['Ana Lopez', 'Juan Diaz']);
  assert.deepEqual(data.failed.map(f => f.name).sort(), ['Gone', 'No Contact']);
  assert.deepEqual(data.pending, []); assert.equal(data.ok, false);
  const [log] = await sql`select actor_name, action, target from dispatch_activity where action = 'Added GHL tag'`;
  assert.equal(log.actor_name, 'Jesse Pickar'); assert.equal(log.target, 'forklift cert, osha 10 on 2 laborers');
});

test('POST refuses no tags, no workers, and cross-site', async () => {
  assert.equal((await handler(req('POST', { tags: [' '], workers: [{ contactId: 'c1' }] }))).status, 400);
  assert.equal((await handler(req('POST', { tags: ['x'], workers: [] }))).status, 400);
  const cross = new Request('https://board.test/api/worker-tags', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: 'https://evil.test' } });
  assert.equal((await handler(cross)).status, 403);
});
