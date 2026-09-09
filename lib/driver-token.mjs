// Stateless driver sign-in tokens. No session table: the token itself carries
// the driver's identity and an expiry, HMAC-signed so it cannot be forged or
// altered client-side. Read-only driver endpoints trust this instead of the
// same-origin CSRF check the dispatcher board uses (see lib/http.mjs).
import { createHmac, timingSafeEqual } from 'node:crypto';

function secret() {
  const value = process.env.DRIVER_TOKEN_SECRET;
  if (!value) throw new Error('DRIVER_TOKEN_SECRET is missing');
  return value;
}

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

export function signDriverToken(payload, ttlSeconds = 180 * 24 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const body = encode({ ...payload, iat: now, exp: now + ttlSeconds });
  const signature = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyDriverToken(token) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  let expected;
  try { expected = createHmac('sha256', secret()).update(body).digest('base64url'); }
  catch { return null; }
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = decode(body); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!payload || typeof payload !== 'object' || !payload.driverKey || !payload.exp || payload.exp < now) return null;
  return payload;
}

export function driverIdentityFromRequest(request) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer /i, '').trim();
  return token ? verifyDriverToken(token) : null;
}

export const normalizePhone = value => String(value || '').replace(/\D/g, '').slice(-10);

export function driverKeyFor({ phone, name }) {
  const digits = normalizePhone(phone);
  if (digits) return `phone:${digits}`;
  return `name:${String(name || '').trim().toLowerCase()}`;
}

// A move only records a plain driverName/driverPhone (see mutateMove's
// assign_driver action) -- match on either, phone first since it's unique.
export function matchesDriver(move, identity) {
  if (!identity || !move) return false;
  const movePhone = normalizePhone(move.driverPhone);
  if (movePhone && identity.phone && movePhone === normalizePhone(identity.phone)) return true;
  const moveName = String(move.driverName || '').trim().toLowerCase();
  return !!moveName && moveName === String(identity.name || '').trim().toLowerCase();
}

// Same identity, but against a labor job's crew list (see normalizeCrew in
// lib/state.mjs -- each crew member is { id, name, phone }).
export function matchesWorker(job, identity) {
  if (!identity || !job) return false;
  const crew = Array.isArray(job.crew) ? job.crew : [];
  return crew.some(w => isSameIdentity(w, identity));
}

export function isSameIdentity(person, identity) {
  if (!person || !identity) return false;
  const personPhone = normalizePhone(person.phone);
  if (personPhone && identity.phone && personPhone === normalizePhone(identity.phone)) return true;
  const personName = String(person.name || '').trim().toLowerCase();
  return !!personName && personName === String(identity.name || '').trim().toLowerCase();
}
