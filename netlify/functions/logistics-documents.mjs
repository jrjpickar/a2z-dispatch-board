import { randomUUID } from 'node:crypto';
import { db, ensureSchema } from './db.mjs';
import { authorizeWrite, json, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
// Files live separately from move state, keeping dashboard refreshes small.
export default async function handler(request) {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST') authorizeWrite(request);
    const sql = db(); await ensureSchema(sql);
    if (request.method === 'GET') {
      const id = new URL(request.url).searchParams.get('id') || '';
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new StateError('Document not found', 404);
      const [doc] = await sql`select name, mime_type, content_base64 from logistics_documents where id = ${id}`;
      if (!doc) throw new StateError('Document not found', 404);
      return new Response(Buffer.from(doc.content_base64, 'base64'), { headers: { 'content-type': doc.mime_type, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' } });
    }
    if (Number(request.headers.get('content-length')) > 4 * 1024 * 1024) throw new StateError('Each document must be 3 MB or smaller', 413);
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function' || !file.size || file.size > 3 * 1024 * 1024) throw new StateError('Each document must be nonempty and 3 MB or smaller', 413);
    const id = randomUUID(), name = String(file.name || 'document').slice(0, 255), type = file.type || 'application/octet-stream';
    const content = Buffer.from(await file.arrayBuffer()).toString('base64');
    await sql`insert into logistics_documents (id, name, mime_type, content_base64) values (${id}, ${name}, ${type}, ${content})`;
    return json({ ok: true, document: { id, name, type, size: file.size, url: `/.netlify/functions/logistics-documents?id=${id}` } });
  } catch (error) { return errorResponse(error); }
}
