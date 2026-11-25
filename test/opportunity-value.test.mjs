import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDispatch } from '../lib/create.mjs';

test('new labor bookings require confirmation of blank, zero, and $10,000+ values', async () => {
  const insertReached = new Error('Reached creation insert');
  const transaction = async strings => {
    if (strings[0].includes('insert into dispatch_creations')) throw insertReached;
    return [];
  };
  transaction.json = value => value;
  const sql = { begin: callback => callback(transaction) };
  const create = (monetaryValue, confirmedOpportunityValue) => createDispatch(sql, 'job', {
    action: 'create', requestId: crypto.randomUUID(), monetaryValue, confirmedOpportunityValue
  });

  for (const [raw, value] of [[undefined, null], [null, null], ['', null], [0, 0], ['0', 0], [10000, 10000], [15000, 15000]]) {
    await assert.rejects(create(raw), { status: 428 });
    await assert.rejects(create(raw, 25000), { status: 428 });
    await assert.rejects(create(raw, value), error => error === insertReached);
  }
  for (const value of [0.01, 9999.99]) {
    await assert.rejects(create(value), error => error === insertReached);
  }
  for (const value of [-1, 'invalid', false, []]) {
    await assert.rejects(create(value), { status: 400 });
  }
});
