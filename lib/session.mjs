// Dashboard sign-in, the same way the Triple Line dialer does it.
//
// Automatic (inside GHL): the board is a Custom Page of the private GHL
// Marketplace app. On load it asks its GHL parent frame for REQUEST_USER_DATA;
// GHL answers with the logged-in user's details encrypted with the app's
// Shared Secret. The server decrypts that with GHL_APP_SHARED_SECRET, checks
// the location, and issues a signed session (via "ghl_sso"). Nobody can fake
// it without the Shared Secret, so it counts for admin rights.
//
// Outside GHL (bookmark, phone): a one-time "Who's using the board?" picker.
// Picker sessions never get admin rights unless DASHBOARD_ADMIN_PIN is entered.
//
// The session is kept in a signed HttpOnly cookie plus the same token as a
// header (GHL's iframe can block cookies). GHL sessions last 7 days and are
// renewed on every load inside GHL; picker sessions last 180 days.
//
// Admin is decided by the admin list on the board (dispatch_admins), plus
// BOOTSTRAP_ADMINS (default: Jesse Pickar) who can never be locked out.
import { createHmac, createHash, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { StateError } from './state.mjs';
import { listLocationUsers } from './ghl.mjs';

export const SESSION_COOKIE = 'a2z_session';
export const SESSION_HEADER = 'x-a2z-session';
const TTL = 180 * 24 * 3600;

function secret() {
  const value = process.env.SESSION_SECRET || process.env.DRIVER_TOKEN_SECRET;
  if (!value) throw new StateError('SESSION_SECRET (or DRIVER_TOKEN_SECRET) is missing in Netlify.', 500);
  return value;
}
const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
const sign = body => createHmac('sha256', 'session:' + secret()).update(body).digest('base64url');

const SSO_TTL = 7 * 24 * 3600;
export function signSession(user, via) {
  const now = Math.floor(Date.now() / 1000);
  const body = encode({ uid: user.id, name: user.name, email: user.email || '', via, iat: now, exp: now + (via === 'ghl_sso' ? SSO_TTL : TTL) });
  return `${body}.${sign(body)}`;
}
export function verifySession(token) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  let expected; try { expected = sign(body); } catch { return null; }
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload; try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload?.uid || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}
export function sessionFromRequest(request) {
  return verifySession(request.headers.get(SESSION_HEADER) || readCookie(request, SESSION_COOKIE));
}
// SameSite=None + Partitioned so it also works when the board is embedded in GHL.
export const sessionCookie = token => `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${TTL}; HttpOnly; Secure; SameSite=None; Partitioned`;
export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`;

// ---------- GHL users (cached briefly per function instance) ----------
let usersCache = { at: 0, users: null };
export async function ghlUsers({ fresh = false } = {}) {
  if (!fresh && usersCache.users && Date.now() - usersCache.at < 5 * 60 * 1000) return usersCache.users;
  const users = await listLocationUsers();
  usersCache = { at: Date.now(), users };
  return users;
}
export const _setUsersForTest = users => { usersCache = { at: Date.now(), users }; };

const norm = v => String(v || '').trim().toLowerCase();
// Senior admins (SENIOR_ADMINS, or the older name BOOTSTRAP_ADMINS): always
// admin, can't be revoked, and the only ones who can enroll/revoke admins.
// Failsafe: the owner email below is ALWAYS a senior admin, even if the env
// var is deleted, blanked or typed wrong. A blank env var counts as unset.
export const OWNER_EMAIL = 'jesse@a2zcs.net';
export function bootstrapAdmins() {
  const configured = [process.env.SENIOR_ADMINS, process.env.BOOTSTRAP_ADMINS].find(v => String(v || '').trim());
  const list = String(configured || 'Jesse Pickar').split(',').map(norm).filter(Boolean);
  return [...new Set([OWNER_EMAIL, ...list])];
}
export const isBootstrapAdmin = user => !!user && bootstrapAdmins().some(k => k === norm(user.name) || k === norm(user.email) || k === norm(user.id || user.uid));

// Admin rights need a trusted sign-in (GHL encrypted user context, or picker + admin PIN).
export const trustedForAdmin = session => ['ghl_sso', 'pin'].includes(session?.via);

// GHL Custom Page user context: CryptoJS AES ("Salted__" + OpenSSL key
// derivation), same as the dialer's decryptGhlUserData.
export function decryptGhlUserData(encryptedData, passphrase) {
  const raw = Buffer.from(String(encryptedData || ''), 'base64');
  if (raw.length < 17 || raw.subarray(0, 8).toString('ascii') !== 'Salted__') throw new Error('Invalid encrypted context');
  const salt = raw.subarray(8, 16), password = Buffer.from(passphrase), blocks = [];
  let previous = Buffer.alloc(0);
  while (Buffer.concat(blocks).length < 48) { previous = createHash('md5').update(Buffer.concat([previous, password, salt])).digest(); blocks.push(previous); }
  const material = Buffer.concat(blocks);
  const decipher = createDecipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
}
const DEFAULT_LOCATION_ID = 'QUcu2PEAxPV1sQm1GQCq';
// Returns { id, name, email } for a verified GHL user, or throws StateError.
export function ghlUserFromContext(encryptedData) {
  const secretValue = process.env.GHL_APP_SHARED_SECRET;
  if (!secretValue) throw new StateError('GHL_APP_SHARED_SECRET is not set in Netlify, so automatic GHL sign-in is off.', 503);
  if (typeof encryptedData !== 'string' || !encryptedData || encryptedData.length > 20000) throw new StateError('Encrypted GHL user context is required.');
  let user;
  try { user = JSON.parse(decryptGhlUserData(encryptedData, secretValue)); }
  catch { throw new StateError('GHL user context could not be verified. Check GHL_APP_SHARED_SECRET matches the Marketplace app.', 401); }
  if (!user?.userId || !user.email) throw new StateError('GHL user context is incomplete.', 401);
  const location = process.env.GHL_LOCATION_ID || DEFAULT_LOCATION_ID;
  if (!user.activeLocation || user.activeLocation !== location) throw new StateError('This GHL user is not in the A2Z location.', 403);
  return { id: String(user.userId), name: String(user.userName || user.email), email: String(user.email).toLowerCase() };
}
export function secretMatches(supplied, expected) {
  const a = Buffer.from(String(supplied || '')), b = Buffer.from(String(expected || ''));
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export async function adminRows(sql) {
  return sql`select user_id as "userId", name, email, added_by as "addedBy", created_at as "createdAt" from dispatch_admins order by name`;
}
export async function isListedAdmin(sql, session) {
  if (!session) return false;
  if (isBootstrapAdmin(session)) return true;
  const [row] = await sql`select 1 as ok from dispatch_admins where user_id = ${session.uid}`;
  return !!row;
}
export async function sessionInfo(sql, session) {
  if (!session) return { signedIn: false, user: null, isAdmin: false };
  const listed = await isListedAdmin(sql, session);
  return {
    signedIn: true,
    user: { id: session.uid, name: session.name, email: session.email },
    via: session.via,
    adminListed: listed,
    isAdmin: listed && trustedForAdmin(session),
    isSenior: isBootstrapAdmin(session) && trustedForAdmin(session),
    needsAdminUnlock: listed && !trustedForAdmin(session)
  };
}
export async function requireSenior(request, sql) {
  const session = await requireAdmin(request, sql);
  if (!isBootstrapAdmin(session)) throw new StateError('Only a senior admin can enroll or revoke admins.', 403);
  return session;
}
export async function requireSession(request) {
  const session = sessionFromRequest(request);
  if (!session) throw new StateError('Sign in to the dashboard first (reload the page).', 401);
  return session;
}
export async function requireAdmin(request, sql) {
  const session = await requireSession(request);
  const info = await sessionInfo(sql, session);
  if (!info.isAdmin) throw new StateError(info.needsAdminUnlock
    ? 'Admin tools need the board opened inside GHL, or the admin PIN.'
    : 'Only admins can do that.', 403);
  return session;
}

// Finds the GHL user a sign-in refers to.
export function matchUser(users, { userId, email, name }) {
  if (userId) return users.find(u => u.id === String(userId).trim()) || null;
  if (email) return users.find(u => norm(u.email) === norm(email)) || null;
  if (name) return users.find(u => norm(u.name) === norm(name)) || null;
  return null;
}
