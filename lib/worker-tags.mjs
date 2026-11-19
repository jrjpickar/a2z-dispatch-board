// GHL tags on laborers, picked on the Labor board (Labor Roster > Tag).
// Used by netlify/functions/worker-tags.mjs.
export const MAX_TAGS = 10, MAX_WORKERS = 60, MAX_TAG_LENGTH = 60;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

// GHL stores tags lowercase; the board sends what dispatch typed. Same tag twice counts once.
export function cleanTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Set(), tags = [];
  for (const raw of list) {
    const tag = String(raw ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag); tags.push(tag);
  }
  return tags.slice(0, MAX_TAGS);
}

// Each worker by GHL contact id, or by phone when the roster has no id. Duplicates drop out.
export function cleanWorkers(input) {
  const seen = new Set(), workers = [];
  for (const w of Array.isArray(input) ? input : []) {
    const contactId = ID.test(String(w?.contactId || '').trim()) ? String(w.contactId).trim() : '';
    const digits = String(w?.phone || '').replace(/\D/g, '').slice(-10);
    const phone = digits.length === 10 ? digits : '';
    const key = contactId ? `id:${contactId}` : phone ? `phone:${phone}` : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    workers.push({ key, contactId, phone, name: String(w?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80) });
  }
  return workers;
}
