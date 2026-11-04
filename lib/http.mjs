import { timingSafeEqual } from 'node:crypto';
import { StateError, normalizePayload } from './state.mjs';
import { sessionFromRequest } from './session.mjs';
export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
// Security (Nov 2026 audit): the API used to accept any request whose Origin header
// matched the site. Origin is easy to fake outside a browser, so on its own it is CSRF
// protection, not a login. Browser calls now also need a signed board session (the
// X-A2Z-Session header or a2z_session cookie the board already sends on every call).
// Server-to-server callers (Make imports) keep using STATE_SYNC_TOKEN, unchanged.
// Break-glass: set API_AUTH_ENFORCE=off in Netlify to go back to the old behaviour
// (every unauthenticated call is then logged as a warning).
export const apiAuthEnforced = () => String(process.env.API_AUTH_ENFORCE || '').trim().toLowerCase() !== 'off';
function syncTokenOk(request) {
  const expected = process.env.STATE_SYNC_TOKEN || '';
  const supplied = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  return !!expected && supplied.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}
function signedIn(request) {
  try { return !!sessionFromRequest(request); } catch { return false; }
}
function allowUnsigned(request, kind) {
  if (apiAuthEnforced()) throw new StateError('Sign in to the dispatch board first.', 401);
  console.warn(`API_AUTH_ENFORCE=off: allowed an unsigned ${kind} to ${new URL(request.url).pathname}`);
}
export function authorizeWrite(request) {
  const origin = request.headers.get('origin');
  if (origin === new URL(request.url).origin && request.headers.get('sec-fetch-site') !== 'cross-site') {
    if (signedIn(request)) return;
    return allowUnsigned(request, 'write');
  }
  // Server-to-server imports need a secret. Same-origin is CSRF protection, not user authentication.
  if (syncTokenOk(request)) return;
  throw new StateError('Same-origin browser request or STATE_SYNC_TOKEN required', 403);
}
// Sign-in itself (POST /api/session) can't need a session yet: it keeps the old
// same-origin check (CSRF protection). Every action there proves who you are anyway
// (GHL's encrypted context, your GHL user ID, or the admin PIN).
export function authorizeOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin === new URL(request.url).origin && request.headers.get('sec-fetch-site') !== 'cross-site') return;
  if (syncTokenOk(request)) return;
  throw new StateError('Same-origin browser request or STATE_SYNC_TOKEN required', 403);
}
// Reads (board data, rosters, settings, field app list) need a signed session or STATE_SYNC_TOKEN.
export function authorizeRead(request) {
  if (signedIn(request) || syncTokenOk(request)) return;
  allowUnsigned(request, 'read');
}
// Same check for handlers that build their own responses: returns a ready 401, or null.
export function readDenied(request) {
  try { authorizeRead(request); return null; } catch (error) { return errorResponse(error); }
}
export async function readPayload(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) throw new StateError('Content-Type must be application/json', 415);
  const text = await request.text();
  if (Buffer.byteLength(text) > 128 * 1024) throw new StateError('Payload too large', 413);
  try { return normalizePayload(JSON.parse(text)); } catch (e) { if (e instanceof StateError) throw e; throw new StateError('Request body must be valid JSON'); }
}
export function errorResponse(error) {
  if (!(error instanceof StateError)) console.error('State operation failed', error);
  return json({ error: error instanceof StateError ? error.message : 'Shared state could not be saved. Retry after refreshing.' }, error.status || 500);
}
