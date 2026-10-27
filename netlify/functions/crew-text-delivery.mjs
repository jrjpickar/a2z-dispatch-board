// Delivery URL for the crew text SMS Conversation Provider (/api/crew-text-delivery).
// The board texts through Twilio itself and only logs the text in GHL, so GHL should
// never need this. If someone picks this provider in GHL anyway, nothing is sent:
// it just answers ok so GHL doesn't error.
export default async function handler(request) {
  if (request.method === 'POST') { try { console.warn('crew-text-delivery: GHL tried to send through the crew text provider; nothing was sent', await request.text()); } catch {} }
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}
