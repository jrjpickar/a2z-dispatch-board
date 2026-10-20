import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateMove } from '../lib/state.mjs';
import { validateLogisticsBooking } from '../lib/logistics-booking.mjs';
const fields = { clientContact: 'Maria +15555550100', predictedEndDate: '2026-10-23', scheduledDays: 'Monday–Friday', scheduledHours: '7 AM–3 PM', overweightTons: 2.25, documents: [{ id: '69f8730d-d5cf-4653-83d9-3529c621215d', name: 'Proposal.pdf', type: 'application/pdf', size: 123 }] };
test('booking and edits preserve separate scope, notes, tonnage and documents', () => {
  const created = mutateMove(null, { action: 'create', ...fields, scopeOfWork: 'Proposal scope', notes: 'Gate code 1234', reportDate: '2026-10-20', reportTime: '08:00' });
  assert.equal(created.data.overweightTons, 2.25);
  assert.equal(created.data.scopeOfWork, 'Proposal scope');
  assert.equal(created.data.notes, 'Gate code 1234');
  assert.equal(created.data.documents[0].name, 'Proposal.pdf');
  const edited = mutateMove(created, { action: 'update_job', overweightTons: 3.5, reportDate: '2026-10-20', reportTime: '08:00' });
  assert.equal(edited.data.overweightTons, 3.5);
  assert.equal(edited.data.clientContact, fields.clientContact);
  assert.equal(edited.data.documents[0].id, fields.documents[0].id);
});
test('EOD captures work details and overweight before clearing resources', () => {
  const before = { data: { ...fields, scheduledDate: '2026-10-20', scheduledTime: '08:00', driverName: 'Ana', assets: [{ assetId: 'truck1' }], status: 'assigned', active: true } };
  const next = mutateMove(before, { action: 'reset_dispatch', eodSheet: true, ...fields, overweightTons: 4, date: '2026-10-20', reportDate: '2026-10-20', reportTime: '08:00', scopeOfWork: 'Full proposal', notes: 'EOD notes' });
  assert.equal(next.data.lastEodSheet.overweightTons, 4);
  assert.equal(next.data.lastEodSheet.reportTime, '08:00');
  assert.equal(next.data.lastEodSheet.notes, 'EOD notes');
  assert.equal(next.data.documents[0].name, 'Proposal.pdf');
  assert.equal(next.data.predictedEndDate, fields.predictedEndDate);
  assert.equal(next.data.scheduledDate, '');
  assert.equal(next.data.driverName, '');
  assert.deepEqual(next.data.assets, []);
});
test('invalid tonnage and document metadata are rejected', () => {
  for (const value of [-1, 'bad', Infinity]) assert.throws(() => validateLogisticsBooking({ overweightTons: value }), /Overweight/);
  assert.throws(() => validateLogisticsBooking({ documents: [{ name: 'fake.pdf' }] }), /document/);
  assert.throws(() => validateLogisticsBooking({ predictedEndDate: 'not a date' }), /predicted end/);
});
