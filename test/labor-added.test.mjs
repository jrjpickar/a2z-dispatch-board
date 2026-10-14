import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
process.env.SESSION_SECRET = 'test-secret'; process.env.GHL_API_TOKEN = 'x';
const { signSession } = await import('../lib/session.mjs');
const { default: handler } = await import('../netlify/functions/manual-workers.mjs');
const { clientSummary } = await import('../lib/ghl.mjs');
const jesse = { id: 'uJessePickar01', name: 'Jesse Pickar', email: 'jesse@a2zcs.net' };
const post = body => new Request('https://board.test/api/manual-workers', { method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', origin: 'https://board.test', 'x-a2z-session': signSession(jesse, 'ghl_sso') } });

test('adding a laborer posts one labor_added run in the background and answers without waiting on Make', async () => {
  const makeRuns = []; let releaseMake;
  const makeGate = new Promise(r => { releaseMake = r; });
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes('leadconnectorhq.com/contacts/c123456')) return Response.json({ contact: { id: 'c123456', firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100', email: 'ana@x.com', tags: ['labor'] } });
    if (url.includes('hook.us2.make.com/wk9leiggp4mlr2g5n1acq862y6my52ia')) { makeRuns.push(JSON.parse(init.body)); await makeGate; return Response.json({ ok: true }); }
    throw new Error('unexpected fetch ' + url);
  };
  await real.ensureSchema(adapter(pg)); // schema setup is not part of the timing
  let background;
  const context = { waitUntil: p => { background = p; } };
  const started = Date.now();
  const res = await handler(post({ action: 'add', contactId: 'c123456', labor: true, driver: false, fieldApp: true }), context);
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.ok(Date.now() - started < 2000, 'did not wait for Make');
  assert.equal(data.webhookQueued, true); assert.equal(data.fieldApp.name, 'Ana Lopez');
  assert.deepEqual(data.workers.map(w => w.name), ['Ana Lopez']);
  assert.ok(background, 'send handed to waitUntil');
  releaseMake(); await background;
  assert.equal(makeRuns.length, 1);
  const run = makeRuns[0];
  assert.equal(run.action, 'newWorker'); assert.equal(run.contactId, 'c123456'); assert.equal(run.workerName, 'Ana Lopez');
  assert.equal(run.workerPhone, '+15555550100'); assert.equal(run.crew, true); assert.equal(run.driver, false); assert.equal(run.roles, 'Crew');
  assert.equal(run.fieldApp, true); assert.equal(run.isNew, true); assert.equal(run.addedBy, 'Jesse Pickar'); assert.ok(run.eventId);
  const sql = adapter(pg);
  const [row] = await sql`select status, kind from dispatch_effects where kind = 'labor_added'`;
  assert.equal(row.status, 'confirmed');
  // Adding the same contact again (an update) still posts, marked isNew false.
  releaseMake = null;
  let bg2; await (await handler(post({ action: 'add', contactId: 'c123456', labor: true, driver: true, fieldApp: true }), { waitUntil: p => { bg2 = p; } })).json();
  await bg2;
  assert.equal(makeRuns.length, 2); assert.equal(makeRuns[1].isNew, false); assert.equal(makeRuns[1].roles, 'Crew/Driver');
});

test('a Make failure is kept as a problem with its payload so it can be retried', async () => {
  globalThis.fetch = async url => String(url).includes('leadconnectorhq.com')
    ? Response.json({ contact: { id: 'c999999', firstName: 'Bob', lastName: 'Ray', phone: '+15555550101' } })
    : new Response('Accepted', { status: 200 });
  let bg; const res = await handler(post({ action: 'add', contactId: 'c999999', labor: true, fieldApp: false }), { waitUntil: p => { bg = p; } });
  assert.equal(res.status, 200); await bg;
  const [row] = await adapter(pg)`select status, payload from dispatch_effects where kind = 'labor_added' and payload::text like '%c999999%'`;
  assert.equal(row.status, 'uncertain');
});

test('Book Job client search summary', () => {
  assert.deepEqual(clientSummary({ id: 'k1', firstName: 'Maria', lastName: 'Gomez', phone: '(714) 555-0100', address1: '12 Main St', city: 'Irvine', state: 'CA', postalCode: '92618', companyName: 'Gomez LLC' }),
    { id: 'k1', name: 'Maria Gomez', firstName: 'Maria', lastName: 'Gomez', phone: '+17145550100', email: '', address: '12 Main St, Irvine, CA 92618', companyName: 'Gomez LLC' });
});
