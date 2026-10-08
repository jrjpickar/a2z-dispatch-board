import test from 'node:test';
import assert from 'node:assert/strict';
import { workflows, webhookUrl } from '../lib/effects.mjs';
test('split day bookings go to their own Make webhook, overridable by SPLIT_DAY_WEBHOOK', () => {
  assert.ok(workflows.split_day);
  delete process.env.SPLIT_DAY_WEBHOOK;
  assert.equal(webhookUrl('split_day'), 'https://hook.us2.make.com/pnoqc8i87kix7qiyjkmfek9axgvjh4z6');
  process.env.SPLIT_DAY_WEBHOOK = 'https://example.test/hook';
  try { assert.equal(webhookUrl('split_day'), 'https://example.test/hook'); } finally { delete process.env.SPLIT_DAY_WEBHOOK; }
  assert.notEqual(webhookUrl('workers'), webhookUrl('split_day'));
});
