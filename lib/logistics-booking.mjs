import { StateError } from './state.mjs';
export const LOGISTICS_BOOKING_FIELDS = ['clientContact', 'predictedEndDate', 'scheduledDays', 'scheduledHours', 'overweightTons', 'documents'];
export function validateLogisticsBooking(input) {
  const patch = {};
  for (const key of LOGISTICS_BOOKING_FIELDS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (key === 'overweightTons') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new StateError('Overweight tons must be zero or greater');
      patch[key] = n;
    } else if (key === 'documents') {
      if (!Array.isArray(value) || value.length > 20) throw new StateError('Attach up to 20 documents');
      patch[key] = value.map(doc => {
        if (!doc || !/^[a-f0-9-]{36}$/.test(String(doc.id || '')) || !String(doc.name || '').trim()) throw new StateError('Invalid document');
        return { id: doc.id, name: String(doc.name).slice(0, 255), size: Number(doc.size) || 0, type: String(doc.type || ''), url: `/.netlify/functions/logistics-documents?id=${doc.id}` };
      });
    } else {
      patch[key] = String(value || '').trim().slice(0, 4000);
      if (key === 'predictedEndDate' && patch[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(patch[key]) || Number.isNaN(Date.parse(patch[key] + 'T12:00:00Z')))) throw new StateError('Enter a valid predicted end date');
    }
  }
  return patch;
}
