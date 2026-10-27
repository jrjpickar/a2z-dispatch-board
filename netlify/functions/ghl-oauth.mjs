// GHL Marketplace app install callback (/api/oauth/callback), same flow as the Triple
// Line dialer. Saves the location OAuth token the crew schedule text uses to log each
// Twilio text in GHL Conversations. Add PUBLIC_APP_URL/api/oauth/callback as a redirect
// URL in the Marketplace app, then install (or update) the app on the location.
import { db, ensureSchema } from './db.mjs';
import { oauthTokenRequest, locationTokenFromAgency, saveOauthToken } from '../../lib/crew-text.mjs';
const page = (title, text, status = 200) => new Response(`<!doctype html><meta charset=utf-8><title>${title}</title><style>body{font:16px system-ui;padding:40px;color:#1c1d1f}main{max-width:560px;margin:auto}h1{color:#e8622c}</style><main><h1>${title}</h1><p>${text}</p></main>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export default async function handler(request) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const url = new URL(request.url);
  try {
    if (url.searchParams.get('error')) throw new Error(`GHL OAuth: ${url.searchParams.get('error')}`);
    const code = url.searchParams.get('code');
    if (!code) return page('Missing code', 'Open this from the GHL Marketplace app install.', 400);
    const base = (process.env.PUBLIC_APP_URL || url.origin).replace(/\/$/, '');
    const configured = process.env.GHL_LOCATION_ID || 'QUcu2PEAxPV1sQm1GQCq';
    let token = await oauthTokenRequest({ grant_type: 'authorization_code', code, user_type: 'Location', redirect_uri: `${base}/api/oauth/callback` });
    if (!token.locationId && token.companyId) token = await locationTokenFromAgency(token, configured);
    if (!token.locationId) throw new Error('GHL OAuth did not return a location ID');
    if (token.locationId !== configured) return page('Wrong location', 'This app install is for a different GHL location.', 403);
    const sql = db(); await ensureSchema(sql);
    await saveOauthToken(sql, token);
    return page('A2Z Dispatch connected', 'Crew schedule texts will now show in GHL Conversations. You can close this tab.');
  } catch (error) {
    console.error('GHL OAuth callback failed', error);
    return page('Not connected', esc(error.message || 'GHL OAuth failed'), 502);
  }
}
