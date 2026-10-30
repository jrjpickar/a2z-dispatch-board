import test, { mock } from 'node:test'; import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function adapter(e) { const sql = async (s, ...v) => (await e.query(s.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), v)).rows; sql.json = JSON.stringify; sql.begin = cb => e.transaction(tx => cb(adapter(tx))); return sql; }
const real = await import('../netlify/functions/db.mjs');
mock.module('../netlify/functions/db.mjs', { namedExports: { db: () => adapter(pg), ensureSchema: real.ensureSchema } });
process.env.SESSION_SECRET = 'test-secret'; process.env.GHL_API_TOKEN = 'x';
const { signSession } = await import('../lib/session.mjs');
const { default: handler } = await import('../netlify/functions/manual-workers.mjs');
const FIELD = 'xOi9gCcAt2UvgA6POHMB';
const jesse = { id: 'uJessePickar01', name: 'Jesse Pickar', email: 'jesse@a2zcs.net' };
const nobody = { id: 'uNotAnAdmin01', name: 'Sam Nobody', email: 'sam@example.com' };
const headers = who => ({ 'content-type': 'application/json', origin: 'https://board.test', 'x-a2z-session': signSession(who, 'ghl_sso') });
const post = (body, who = jesse) => new Request('https://board.test/api/manual-workers', { method: 'POST', body: JSON.stringify(body), headers: headers(who) });
const get = (q, who = jesse) => new Request('https://board.test/api/manual-workers?' + q, { headers: headers(who) });

let contact, puts;
function fakeGhl() {
  contact = { id: 'cTemp00001', firstName: 'Ana', lastName: 'Lopez', phone: '+17145550100', email: '', customFields: [{ id: FIELD, value: 'Cold' }] };
  puts = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes(`/customFields/${FIELD}`)) return Response.json({ customField: { id: FIELD, picklistOptions: ['Hot', 'Warm', 'Cold'] } });
    if (url.includes('/contacts/search/duplicate')) return Response.json({ contact: { id: contact.id } });
    if (url.includes('/contacts/cTemp00001') && init.method === 'PUT') {
      const body = JSON.parse(init.body); puts.push(body);
      for (const f of body.customFields || []) contact.customFields = [{ id: f.id, value: f.field_value }];
      Object.assign(contact, { firstName: body.firstName, lastName: body.lastName, phone: body.phone });
      return Response.json({ contact });
    }
    if (url.includes('/contacts/cTemp00001')) return Response.json({ contact });
    throw new Error('unexpected fetch ' + url);
  };
}

test('admin loads and changes a worker Temperature in GHL; board cache follows', async () => {
  fakeGhl();
  const loaded = await (await handler(get('contact=cTemp00001'))).json();
  assert.equal(loaded.contact.temperature, 'Cold');
  assert.deepEqual(loaded.temperatureOptions, ['Hot', 'Warm', 'Cold']);
  const byPhone = await (await handler(get('phone=' + encodeURIComponent('(714) 555-0100')))).json();
  assert.equal(byPhone.contact.id, 'cTemp00001');

  const res = await handler(post({ action: 'edit', contactId: 'cTemp00001', firstName: 'Ana', lastName: 'Lopez', phone: '+17145550100', temperature: 'warm' }));
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.temperature, 'Warm'); assert.equal(data.temperatureChanged, true);
  assert.deepEqual(puts[0].customFields, [{ id: FIELD, field_value: 'Warm' }]);
  assert.ok(data.changes.includes('temperature Cold → Warm'));
  const cache = await adapter(pg)`select contact_id, value from dispatch_worker_temperature order by contact_id`;
  assert.deepEqual(cache.map(r => [r.contact_id, r.value]), [['cTemp00001', 'Warm'], ['phone:7145550100', 'Warm']]);

  // Same value again: no custom field write.
  await handler(post({ action: 'edit', contactId: 'cTemp00001', firstName: 'Ana', lastName: 'Lopez', phone: '+17145550100', temperature: 'Warm' }));
  assert.equal(puts[1].customFields, undefined);
  // No temperature sent (name only edit): left alone.
  const nameOnly = await (await handler(post({ action: 'edit', contactId: 'cTemp00001', firstName: 'Ana', lastName: 'Lopez', phone: '+17145550100' }))).json();
  assert.equal(nameOnly.temperatureChanged, false); assert.equal(puts[2].customFields, undefined);
  // Blank clears it.
  const cleared = await (await handler(post({ action: 'edit', contactId: 'cTemp00001', firstName: 'Ana', lastName: 'Lopez', phone: '+17145550100', temperature: '' }))).json();
  assert.equal(cleared.temperature, ''); assert.deepEqual(puts[3].customFields, [{ id: FIELD, field_value: '' }]);
});

test('bad Temperature values are refused and nothing is written', async () => {
  fakeGhl();
  const res = await handler(post({ action: 'edit', contactId: 'cTemp00001', firstName: 'Ana', lastName: 'Lopez', phone: '+17145550100', temperature: 'Lukewarm' }));
  assert.equal(res.status, 400);
  assert.equal(puts.length, 0);
});

test('non admins cannot change Temperature', async () => {
  fakeGhl();
  const res = await handler(post({ action: 'edit', contactId: 'cTemp00001', firstName: 'Ana', lastName: 'Lopez', phone: '+17145550100', temperature: 'Hot' }, nobody));
  assert.ok([401, 403].includes(res.status), String(res.status));
  assert.equal(puts.length, 0);
  const read = await handler(get('contact=cTemp00001', nobody));
  assert.ok([401, 403].includes(read.status));
});
