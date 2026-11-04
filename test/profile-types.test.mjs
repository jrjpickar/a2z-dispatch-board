// Profile types: Senior Admin, Admin, User (default, dispatcher) and Viewer (read only).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
process.env.API_AUTH_ENFORCE = 'on';
process.env.SESSION_SECRET = 'profile-test-secret';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
const { signSession, _setUsersForTest, sessionInfo } = await import('../lib/session.mjs');
const { default: admins } = await import('../netlify/functions/admins.mjs');
const { default: shared } = await import('../netlify/functions/shared-state.mjs');
const sql = adapter(pg); await real.ensureSchema(sql);
const JESSE = { id: 'uJesse', name: 'Jesse Pickar', email: 'jesse@a2zcs.net' }, ADA = { id: 'uAda', name: 'Ada Admin', email: 'ada@a2zcs.net' }, VIC = { id: 'uVic', name: 'Vic Viewer', email: 'vic@a2zcs.net' }, UMA = { id: 'uUma', name: 'Uma User', email: 'uma@a2zcs.net' };
_setUsersForTest([JESSE, ADA, VIC, UMA]);
await sql`insert into dispatch_admins (user_id, name, email, added_by) values ('uAda', 'Ada Admin', 'ada@a2zcs.net', 'Jesse Pickar')`;
const tok = (u, via = 'ghl_sso') => signSession(u, via);
const post = (u, body) => admins(new Request('https://board.test/api/admins', { method: 'POST', headers: { origin: 'https://board.test', 'content-type': 'application/json', 'x-a2z-session': tok(u) }, body: JSON.stringify(body) }));
const info = async u => sessionInfo(sql, { uid: u.id, name: u.name, email: u.email, via: 'ghl_sso' });

test('everyone not set is a User (dispatcher), as before', async () => {
  assert.equal((await info(UMA)).profileType, 'user');
  assert.equal((await info(VIC)).isViewer, false);
  assert.equal((await info(ADA)).profileType, 'admin');
  assert.equal((await info(JESSE)).profileType, 'senior');
});

test('an admin can make someone a Viewer and back; a User cannot', async () => {
  assert.equal((await post(UMA, { action: 'set_role', userId: 'uVic', role: 'viewer' })).status, 403);
  const res = await post(ADA, { action: 'set_role', userId: 'uVic', role: 'viewer' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).roles.map(r => [r.userId, r.role]), [['uVic', 'viewer']]);
  assert.equal((await info(VIC)).profileType, 'viewer');
  assert.equal((await post(ADA, { action: 'set_role', userId: 'uVic', role: 'boss' })).status, 400);
  assert.equal((await post(ADA, { action: 'set_role', userId: 'uAda', role: 'viewer' })).status, 409, 'admins keep full access');
  assert.equal((await post(ADA, { action: 'set_role', userId: 'uJesse', role: 'viewer' })).status, 409, 'senior admin too');
});

test('a Viewer can load the board but every write is refused', async () => {
  const get = await shared(new Request('https://board.test/api/shared-state', { headers: { 'x-a2z-session': tok(VIC, 'user_id') } }));
  assert.equal(get.status, 200);
  const write = await shared(new Request('https://board.test/api/shared-state', { method: 'POST', headers: { origin: 'https://board.test', 'content-type': 'application/json', 'x-a2z-session': tok(VIC, 'user_id') }, body: JSON.stringify({ action: 'save', jobId: 'j1' }) }));
  assert.equal(write.status, 403);
  assert.match((await write.json()).error, /View only/);
});

test('switching back to User and enrolling as admin both clear Viewer', async () => {
  assert.equal((await post(ADA, { action: 'set_role', userId: 'uVic', role: 'user' })).status, 200);
  assert.equal((await info(VIC)).profileType, 'user');
  await post(ADA, { action: 'set_role', userId: 'uUma', role: 'viewer' });
  assert.equal((await post(JESSE, { action: 'add', userId: 'uUma' })).status, 200);
  assert.equal((await info(UMA)).profileType, 'admin');
  assert.equal((await sql`select count(*)::int as n from dispatch_user_roles`)[0].n, 0);
});

test('only a senior admin can block or unblock; a blocked person is shut out everywhere', async () => {
  const { default: session } = await import('../netlify/functions/session.mjs');
  const { default: settings } = await import('../netlify/functions/settings.mjs');
  const { default: timeClock } = await import('../netlify/functions/time-clock.mjs');
  const vicToken = tok(VIC, 'user_id');
  assert.equal((await post(ADA, { action: 'set_role', userId: 'uVic', role: 'blocked' })).status, 403, 'a regular admin cannot block');
  assert.equal((await post(JESSE, { action: 'set_role', userId: 'uAda', role: 'blocked' })).status, 409, 'revoke admin first');
  assert.equal((await post(JESSE, { action: 'set_role', userId: 'uVic', role: 'blocked' })).status, 200);
  assert.equal((await info(VIC)).signedIn, false);
  assert.equal((await info(VIC)).blocked, true);
  // An old session token stops working for reads, writes and session-only endpoints.
  assert.equal((await settings(new Request('https://board.test/api/settings', { headers: { 'x-a2z-session': vicToken } }))).status, 403);
  assert.equal((await shared(new Request('https://board.test/api/shared-state', { method: 'POST', headers: { origin: 'https://board.test', 'content-type': 'application/json', 'x-a2z-session': vicToken }, body: '{}' }))).status, 403);
  assert.equal((await timeClock(new Request('https://board.test/api/time-clock', { headers: { 'x-a2z-session': vicToken } }))).status, 403);
  // Signing in again is refused.
  process.env.GHL_API_TOKEN = 'pit-test';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('/users/') ? Response.json({ users: [JESSE, ADA, VIC, UMA] }) : Response.json({});
  try {
    const res = await session(new Request('https://board.test/api/session', { method: 'POST', headers: { origin: 'https://board.test', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'signin', userId: 'uVic' }) }));
    assert.equal(res.status, 403); assert.match((await res.json()).error, /blocked/);
  } finally { globalThis.fetch = realFetch; }
  // A regular admin can't unblock; the senior admin can.
  assert.equal((await post(ADA, { action: 'set_role', userId: 'uVic', role: 'user' })).status, 403);
  assert.equal((await post(JESSE, { action: 'set_role', userId: 'uVic', role: 'user' })).status, 200);
  assert.equal((await settings(new Request('https://board.test/api/settings', { headers: { 'x-a2z-session': vicToken } }))).status, 200);
});
