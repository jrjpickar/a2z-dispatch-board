import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureSchema } from '../netlify/functions/db.mjs';
import crypto from 'node:crypto';
import { ghlUserFromContext, signSession, verifySession, sessionFromRequest, sessionInfo, requireAdmin, matchUser, isBootstrapAdmin, secretMatches, sessionCookie } from '../lib/session.mjs';
import { contactSummary } from '../lib/ghl.mjs';
process.env.SESSION_SECRET = 'test-secret';
const pg = new PGlite();
function adapter(engine) {
  const sql = async (strings, ...values) => (await engine.query(strings.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), values)).rows;
  sql.json = v => JSON.stringify(v); sql.begin = cb => engine.transaction(tx => cb(adapter(tx)));
  return sql;
}
const sql = adapter(pg);
await ensureSchema(sql);
const jesse = { id: 'uJessePickar01', name: 'Jesse Pickar', email: 'jesse@a2zcs.net' };
const sam = { id: 'uSamDispatch02', name: 'Sam Dispatcher', email: 'sam@a2zcs.net' };
const req = token => new Request('https://board.test/api/x', { headers: token ? { 'x-a2z-session': token } : {} });

test('session tokens are signed, tamper-proof and read from header or cookie', () => {
  const token = signSession(sam, 'picker');
  assert.equal(verifySession(token).uid, sam.id);
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), uid: jesse.id })).toString('base64url');
  assert.equal(verifySession(`${forged}.${sig}`), null);
  const cookieReq = new Request('https://board.test/', { headers: { cookie: 'x=1; ' + sessionCookie(token).split(';')[0] } });
  assert.equal(sessionFromRequest(cookieReq).name, 'Sam Dispatcher');
  assert.equal(sessionFromRequest(req('')), null);
});
test('Jesse Pickar is a permanent admin, but only on a trusted sign-in', async () => {
  assert.ok(isBootstrapAdmin(jesse));
  assert.ok(!isBootstrapAdmin(sam));
  const viaLink = await sessionInfo(sql, verifySession(signSession(jesse, 'ghl_sso')));
  assert.equal(viaLink.isAdmin, true);
  const viaPicker = await sessionInfo(sql, verifySession(signSession(jesse, 'picker')));
  assert.equal(viaPicker.isAdmin, false); assert.equal(viaPicker.needsAdminUnlock, true);
  await requireAdmin(req(signSession(jesse, 'pin')), sql);
});
test('regular users are refused admin actions until added to the admin list', async () => {
  await assert.rejects(requireAdmin(req(signSession(sam, 'ghl_sso')), sql), e => e.status === 403);
  await assert.rejects(requireAdmin(req(''), sql), e => e.status === 401);
  await sql`insert into dispatch_admins (user_id, name, email) values (${sam.id}, ${sam.name}, ${sam.email})`;
  await requireAdmin(req(signSession(sam, 'ghl_sso')), sql);
  assert.equal((await sessionInfo(sql, verifySession(signSession(sam, 'picker')))).isAdmin, false);
});
test('sign-in matching and secrets', () => {
  const users = [jesse, sam];
  assert.equal(matchUser(users, { userId: sam.id }).name, 'Sam Dispatcher');
  assert.equal(matchUser(users, { email: 'JESSE@a2zcs.net' }).id, jesse.id);
  assert.equal(matchUser(users, { userId: 'nope' }), null);
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abc', ''), false);
  assert.equal(secretMatches('ab', 'abc'), false);
});
test('GHL contacts are summarised for the add-worker search', () => {
  assert.deepEqual(contactSummary({ id: 'c1', firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100' }), { id: 'c1', name: 'Ana Lopez', phone: '+15555550100', email: '', tags: [] });
});

function encryptContext(value, passphrase) {
  const salt = crypto.randomBytes(8), password = Buffer.from(passphrase), blocks = []; let previous = Buffer.alloc(0);
  while (Buffer.concat(blocks).length < 48) { previous = crypto.createHash('md5').update(Buffer.concat([previous, password, salt])).digest(); blocks.push(previous); }
  const material = Buffer.concat(blocks), cipher = crypto.createCipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]).toString('base64');
}
test('automatic GHL sign-in decrypts the Custom Page user context like the dialer', () => {
  process.env.GHL_APP_SHARED_SECRET = 'shared-test-secret';
  process.env.GHL_LOCATION_ID = 'loc-a2z';
  const ctx = { userId: jesse.id, email: 'Jesse@a2zcs.net', userName: 'Jesse Pickar', activeLocation: 'loc-a2z' };
  assert.deepEqual(ghlUserFromContext(encryptContext(ctx, 'shared-test-secret')), { id: jesse.id, name: 'Jesse Pickar', email: 'jesse@a2zcs.net' });
  assert.throws(() => ghlUserFromContext(encryptContext(ctx, 'wrong-secret')), e => e.status === 401);
  assert.throws(() => ghlUserFromContext(encryptContext({ ...ctx, activeLocation: 'other' }, 'shared-test-secret')), e => e.status === 403);
  delete process.env.GHL_APP_SHARED_SECRET;
  assert.throws(() => ghlUserFromContext('x'), e => e.status === 503);
});
