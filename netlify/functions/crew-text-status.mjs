// Twilio delivery reports for crew schedule texts (StatusCallback set on each text in
// lib/crew-text.mjs). Twilio posts form fields MessageSid, MessageStatus, ErrorCode, To.
// Checked with Twilio's X-Twilio-Signature (HMAC-SHA1 with TWILIO_AUTH_TOKEN over the
// callback URL plus the sorted fields). Shown in Admin > Schedule text tracker.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, ensureSchema } from './db.mjs';
import { ensureTable, statusCallbackUrls } from '../../lib/crew-text.mjs';

// Later statuses never get overwritten by an earlier one that arrives late.
const RANK = { accepted: 1, scheduled: 1, queued: 2, sending: 3, sent: 4, delivered: 5, undelivered: 5, failed: 5, read: 6, canceled: 5 };
export function twilioSignature(token, url, params) {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  return createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export default async function handler(request) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return new Response('Not configured', { status: 503 });
  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  const sig = request.headers.get('x-twilio-signature') || '';
  if (!sig || !statusCallbackUrls().some(url => same(twilioSignature(token, url, params), sig))) return new Response('Forbidden', { status: 403 });
  const sid = String(params.MessageSid || params.SmsSid || '').slice(0, 64);
  const status = String(params.MessageStatus || params.SmsStatus || '').toLowerCase().slice(0, 30);
  if (!sid || !status) return new Response(null, { status: 204 });
  const sql = db(); await ensureSchema(sql); await ensureTable(sql);
  const [prev] = await sql`select status from crew_text_status where sid = ${sid}`;
  if (prev && (RANK[prev.status] || 0) > (RANK[status] || 0)) return new Response(null, { status: 204 });
  await sql`insert into crew_text_status (sid, status, error_code, phone, updated_at) values (${sid}, ${status}, ${String(params.ErrorCode || '').slice(0, 20)}, ${String(params.To || '').slice(0, 20)}, now())
    on conflict (sid) do update set status = excluded.status, error_code = excluded.error_code, phone = excluded.phone, updated_at = now()`;
  return new Response(null, { status: 204 });
}
