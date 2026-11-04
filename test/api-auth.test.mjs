// Nov 2026 security update: board API reads and writes need a signed session
// (or STATE_SYNC_TOKEN for server-to-server). Same-origin headers alone are refused.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
process.env.API_AUTH_ENFORCE = 'on';
process.env.SESSION_SECRET = 'test-secret';
process.env.STATE_SYNC_TOKEN = 'sync-token-0123456789';
const { authorizeRead, authorizeWrite, readDenied, apiAuthEnforced } = await import('../lib/http.mjs');
const { signSession } = await import('../lib/session.mjs');
const { default: driverLog } = await import('../netlify/functions/driver-log.mjs');
const { default: settings } = await import('../netlify/functions/settings.mjs');
const { default: roster } = await import('../netlify/functions/roster.mjs');

const token = signSession({ id: 'uSam', name: 'Sam', email: 's@a2zcs.net' }, 'user_id');
const req = (headers = {}, method = 'GET', path = '/api/x') => new Request('https://board.test' + path, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
const sameOrigin = { origin: 'https://board.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const status = async fn => { try { await fn(); return 200; } catch (e) { return e.status; } };

test('enforced by default; only API_AUTH_ENFORCE=off turns it off', () => {
  const saved = process.env.API_AUTH_ENFORCE;
  delete process.env.API_AUTH_ENFORCE; assert.equal(apiAuthEnforced(), true);
  process.env.API_AUTH_ENFORCE = 'OFF '; assert.equal(apiAuthEnforced(), false);
  process.env.API_AUTH_ENFORCE = saved;
});

test('reads need a session or the sync token', async () => {
  assert.equal(await status(() => authorizeRead(req())), 401);
  assert.equal(await status(() => authorizeRead(req({ 'x-a2z-session': token }))), 200);
  assert.equal(await status(() => authorizeRead(req({ cookie: 'a2z_session=' + encodeURIComponent(token) }))), 200);
  assert.equal(await status(() => authorizeRead(req({ authorization: 'Bearer sync-token-0123456789' }))), 200);
  assert.equal(await status(() => authorizeRead(req({ 'x-a2z-session': token.slice(0, -2) + 'xx' }))), 401);
  assert.equal(await status(() => authorizeRead(req({ authorization: 'Bearer wrong' }))), 401);
  assert.equal((await readDenied(req())).status, 401);
  assert.equal(await readDenied(req({ 'x-a2z-session': token })), null);
});

test('a faked Origin header is no longer enough to write', async () => {
  assert.equal(await status(() => authorizeWrite(req(sameOrigin, 'POST'))), 401);
  assert.equal(await status(() => authorizeWrite(req({ ...sameOrigin, 'x-a2z-session': token }, 'POST'))), 200);
  assert.equal(await status(() => authorizeWrite(req({ origin: 'https://evil.test', 'x-a2z-session': token }, 'POST'))), 403);
  assert.equal(await status(() => authorizeWrite(req({ ...sameOrigin, 'sec-fetch-site': 'cross-site', 'x-a2z-session': token }, 'POST'))), 403);
  assert.equal(await status(() => authorizeWrite(req({ origin: 'https://make.test', authorization: 'Bearer sync-token-0123456789' }, 'POST'))), 200);
});

test('off mode keeps the old same-origin behaviour', async () => {
  process.env.API_AUTH_ENFORCE = 'off';
  try {
    assert.equal(await status(() => authorizeRead(req())), 200);
    assert.equal(await status(() => authorizeWrite(req(sameOrigin, 'POST'))), 200);
    assert.equal(await status(() => authorizeWrite(req({ origin: 'https://evil.test' }, 'POST'))), 403);
  } finally { process.env.API_AUTH_ENFORCE = 'on'; }
});

test('handlers refuse before touching the database or Make', async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}'); };
  try {
    assert.equal((await driverLog(req(sameOrigin, 'POST', '/api/driver-log'))).status, 401);
    assert.equal(calls, 0);
    assert.equal((await settings(req({}, 'GET', '/api/settings'))).status, 401);
    assert.equal((await roster(req({}, 'GET', '/api/roster?kind=labor'))).status, 401);
    const ok = await driverLog(req({ ...sameOrigin, 'x-a2z-session': token }, 'POST', '/api/driver-log'));
    assert.equal(ok.status, 200); assert.equal(calls, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('a Viewer profile can read but every write is refused; User is the default', async () => {
  const sql = adapter(pg); await real.ensureSchema(sql);
  const viewer = signSession({ id: 'uVic', name: 'Vic Viewer', email: 'v@a2zcs.net' }, 'user_id');
  const user = signSession({ id: 'uUma', name: 'Uma User', email: 'u@a2zcs.net' }, 'user_id');
  await sql`insert into dispatch_user_roles (user_id, name, role) values ('uVic', 'Vic Viewer', 'viewer')`;
  assert.equal(await status(() => authorizeRead(req({ 'x-a2z-session': viewer }))), 200);
  assert.equal(await status(() => authorizeWrite(req({ ...sameOrigin, 'x-a2z-session': viewer }, 'POST'))), 403);
  assert.equal(await status(() => authorizeWrite(req({ ...sameOrigin, 'x-a2z-session': user }, 'POST'))), 200);
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}'); };
  try { assert.equal((await driverLog(req({ ...sameOrigin, 'x-a2z-session': viewer }, 'POST', '/api/driver-log'))).status, 403); assert.equal(calls, 0); }
  finally { globalThis.fetch = realFetch; }
  // Switching the viewer back to User takes effect on the next request, no sign-out needed.
  await sql`update dispatch_user_roles set role = 'user' where user_id = 'uVic'`;
  assert.equal(await status(() => authorizeWrite(req({ ...sameOrigin, 'x-a2z-session': viewer }, 'POST'))), 200);
});
