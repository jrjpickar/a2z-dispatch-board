import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ensureSchema } from '../netlify/functions/db.mjs';
import crypto from 'node:crypto';
import { requireSenior, ghlUserFromContext, signSession, verifySession, sessionFromRequest, sessionInfo, requireAdmin, matchUser, isBootstrapAdmin, secretMatches, sessionCookie } from '../lib/session.mjs';
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
  assert.deepEqual(contactSummary({ id: 'c1', firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100' }), { id: 'c1', name: 'Ana Lopez', firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100', email: '', tags: [] });
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

test('only senior admins can manage admins', async () => {
  assert.equal((await sessionInfo(sql, verifySession(signSession(jesse, 'ghl_sso')))).isSenior, true);
  await requireSenior(req(signSession(jesse, 'ghl_sso')), sql);
  // Sam is an enrolled admin (earlier test) but not senior.
  assert.equal((await sessionInfo(sql, verifySession(signSession(sam, 'ghl_sso')))).isSenior, false);
  await assert.rejects(requireSenior(req(signSession(sam, 'ghl_sso')), sql), e => e.status === 403 && /senior/.test(e.message));
});

test('the owner email stays a senior admin even if SENIOR_ADMINS is wiped or wrong', () => {
  const jesseByEmail = { id: 'someOtherId', name: 'J', email: 'Jesse@A2ZCS.net' };
  for (const value of [undefined, '', '   ', 'someone-else@x.com']) {
    if (value === undefined) delete process.env.SENIOR_ADMINS; else process.env.SENIOR_ADMINS = value;
    assert.ok(isBootstrapAdmin(jesseByEmail), `owner kept with SENIOR_ADMINS=${JSON.stringify(value)}`);
  }
  process.env.SENIOR_ADMINS = 'someone-else@x.com';
  assert.ok(!isBootstrapAdmin({ id: 'x', name: 'Jesse Pickar', email: 'other@x.com' }), 'name match only applies to the default');
  delete process.env.SENIOR_ADMINS;
});
import { saveSettings, publicSettings, seniorSettings, storedPinMatches } from '../lib/settings.mjs';
import { logActivity, recentActivity, logSend, sendHistory } from '../lib/activity.mjs';
test('senior settings save defaults and a hashed admin PIN', async () => {
  const changed = await saveSettings(sql, { defaultAssignedUserId: 'uSamDispatch02', defaultMarkupPercent: '20', adminPin: '4321' }, 'Jesse Pickar');
  assert.deepEqual(changed, ['default Assigned User', 'default markup %', 'admin PIN changed']);
  assert.deepEqual(await publicSettings(sql), { defaultAssignedUserId: 'uSamDispatch02', defaultMarkupPercent: 20 });
  const [row] = await sql`select value from dispatch_settings where key = 'adminPin'`;
  assert.ok(!JSON.stringify(row.value).includes('4321'), 'PIN is never stored in plain text');
  assert.equal(await storedPinMatches(sql, '4321'), true);
  assert.equal(await storedPinMatches(sql, '0000'), false);
  assert.equal((await seniorSettings(sql)).adminPinSet, true);
  await saveSettings(sql, { clearAdminPin: true, defaultMarkupPercent: '' }, 'Jesse Pickar');
  assert.equal(await storedPinMatches(sql, '4321'), false);
  assert.equal((await publicSettings(sql)).defaultMarkupPercent, '');
  await assert.rejects(saveSettings(sql, { defaultMarkupPercent: 'abc' }, 'x'), /Markup/);
});
test('activity log and send history record who did what', async () => {
  await logActivity(sql, { uid: jesse.id, name: 'Jesse Pickar' }, 'Enrolled admin', 'Sam Dispatcher', { userId: sam.id });
  await logSend(sql, { kind: 'eod_sheet', jobId: 'job9', jobName: 'Acme', fileName: 'EOD Sheet - Acme.xlsx', status: 'sent' });
  const [latest] = await recentActivity(sql);
  assert.deepEqual([latest.actor, latest.action, latest.target], ['Jesse Pickar', 'Enrolled admin', 'Sam Dispatcher']);
  const [sent] = await sendHistory(sql);
  assert.deepEqual([sent.kind, sent.jobId, sent.status], ['eod_sheet', 'job9', 'sent']);
});
import { normalizeContactPhone } from '../lib/ghl.mjs';
test('worker phone edits are saved to GHL in +1 format', () => {
  assert.equal(normalizeContactPhone('(714) 555-0100'), '+17145550100');
  assert.equal(normalizeContactPhone('1-714-555-0100'), '+17145550100');
  assert.equal(normalizeContactPhone('+52 55 1234 5678'), '+525512345678');
  assert.equal(normalizeContactPhone(''), '');
  assert.throws(() => normalizeContactPhone('555-0100'), /10-digit/);
});
test('the one-time 1.8 migration acknowledged old problems and is repeatable', async () => {
  const [row] = await sql`select 1 as ok from dispatch_settings where key = 'migration:ack-problems-1.8'`;
  assert.ok(row);
});
