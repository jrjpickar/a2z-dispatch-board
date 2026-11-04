// With the API sign-in check on, signing in must still work without a session
// (POST /api/session is how you get one). It keeps the same-origin CSRF check.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
process.env.API_AUTH_ENFORCE = 'on';
process.env.SESSION_SECRET = 'signin-test-secret';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
const { _setUsersForTest, verifySession } = await import('../lib/session.mjs');
const { default: session } = await import('../netlify/functions/session.mjs');
const { default: settings } = await import('../netlify/functions/settings.mjs');
_setUsersForTest([{ id: 'uSamDispatch02', name: 'Sam Dispatcher', email: 'sam@a2zcs.net' }]);
process.env.GHL_API_TOKEN = 'pit-test';
// Sign-in reloads the GHL user list; answer it locally (no real GHL call).
globalThis.fetch = async url => String(url).includes('/users/') ? Response.json({ users: [{ id: 'uSamDispatch02', name: 'Sam Dispatcher', email: 'sam@a2zcs.net' }] }) : Response.json({});
const post = (body, headers = {}) => session(new Request('https://board.test/api/session', { method: 'POST', headers: { origin: 'https://board.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

test('a signed-out browser can sign in with its GHL user ID, then use the API', async () => {
  const res = await post({ action: 'signin', source: 'user_id', userId: 'uSamDispatch02' });
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(verifySession(info.token).uid, 'uSamDispatch02');
  assert.equal((await settings(new Request('https://board.test/api/settings'))).status, 401);
  assert.equal((await settings(new Request('https://board.test/api/settings', { headers: { 'x-a2z-session': info.token } }))).status, 200);
});

test('sign-in still refuses cross-site posts and wrong IDs', async () => {
  assert.equal((await post({ action: 'signin', userId: 'uSamDispatch02' }, { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ action: 'signin', userId: 'wrong' })).status, 401);
});
