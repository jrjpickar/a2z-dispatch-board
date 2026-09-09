import { timingSafeEqual } from 'node:crypto';
import { StateError, normalizePayload } from './state.mjs';
export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
export function authorizeWrite(request) {
  const origin = request.headers.get('origin');
  if (origin === new URL(request.url).origin && request.headers.get('sec-fetch-site') !== 'cross-site') return;
  // Server-to-server imports need a secret. Same-origin is CSRF protection, not user authentication.
  const expected = process.env.STATE_SYNC_TOKEN || '';
  const supplied = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (expected && supplied.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return;
  throw new StateError('Same-origin browser request or STATE_SYNC_TOKEN required', 403);
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
