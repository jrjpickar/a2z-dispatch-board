import test from 'node:test';
import assert from 'node:assert/strict';
import { temperatureFieldId, customFieldValue } from '../lib/ghl.mjs';

test('finds the Temperature field by its {{contact.temperature}} key and reads a contact value', async () => {
  process.env.GHL_API_TOKEN = 'x'; delete process.env.GHL_TEMPERATURE_FIELD_ID;
  const realFetch = globalThis.fetch; let url = '';
  globalThis.fetch = async u => { url = String(u); return new Response(JSON.stringify({ customFields: [
    { id: 'f1', name: 'Trade', fieldKey: 'contact.trade' }, { id: 'fTemp', name: 'Temperature', fieldKey: 'contact.temperature', dataType: 'SINGLE_OPTIONS' }] }), { status: 200 }); };
  try { assert.equal(await temperatureFieldId({ lookup: true }), 'fTemp'); } finally { globalThis.fetch = realFetch; }
  assert.match(url, /\/locations\/[^/]+\/customFields\?model=contact/);
  assert.equal(customFieldValue({ customFields: [{ id: 'f1', value: 'Drywall' }, { id: 'fTemp', value: 'Hot' }] }, 'fTemp'), 'Hot');
  assert.equal(customFieldValue({ customFields: [{ id: 'fTemp', field_value: 'Cold' }] }, 'fTemp'), 'Cold');
  assert.equal(customFieldValue({ customFields: [] }, 'fTemp'), '');
  assert.equal(customFieldValue({}, 'fTemp'), '');
});

test('uses A2Z\'s Temperature field id by default, env overrides it', async () => {
  assert.equal(await temperatureFieldId(), 'xOi9gCcAt2UvgA6POHMB');
  process.env.GHL_TEMPERATURE_FIELD_ID = 'fixed';
  try { assert.equal(await temperatureFieldId(), 'fixed'); } finally { delete process.env.GHL_TEMPERATURE_FIELD_ID; }
});
