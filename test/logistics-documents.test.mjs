import test from 'node:test';
import assert from 'node:assert/strict';
const stored = new Map();
const sql = async (parts, ...values) => {
  const query = parts.join('?');
  if (query.includes('insert into logistics_documents')) {
    const [id, name, mime_type, content_base64] = values;
    stored.set(id, { name, mime_type, content_base64 }); return [];
  }
  if (query.includes('select name')) return stored.has(values[0]) ? [stored.get(values[0])] : [];
  throw new Error('Unexpected database query');
};
test('document endpoint saves bytes, returns a download and rejects oversized uploads', async t => {
  t.mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => sql, ensureSchema: async () => {} } });
  const { default: handler } = await import('../netlify/functions/logistics-documents.mjs');
  const bytes = new Uint8Array([0, 1, 2, 255, 14]);
  const form = new FormData(); form.append('file', new File([bytes], 'proposal.pdf', { type: 'application/pdf' }));
  const response = await handler(new Request('https://a2z.test/.netlify/functions/logistics-documents', { method: 'POST', headers: { origin: 'https://a2z.test' }, body: form }));
  assert.equal(response.status, 200);
  const { document } = await response.json();
  const download = await handler(new Request('https://a2z.test' + document.url));
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  assert.match(download.headers.get('content-disposition'), /attachment.*proposal.pdf/);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  const oversized = new FormData(); oversized.append('file', new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'large.pdf'));
  assert.equal((await handler(new Request('https://a2z.test/.netlify/functions/logistics-documents', { method: 'POST', headers: { origin: 'https://a2z.test' }, body: oversized }))).status, 413);
  assert.equal((await handler(new Request('https://a2z.test/.netlify/functions/logistics-documents?id=invalid'))).status, 404);
});
