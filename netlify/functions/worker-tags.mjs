// GHL tags on laborers picked on the Labor board (Labor Roster > Tag).
//   GET  /api/worker-tags  -> { ok, tags: ["tag", ...] }   the location's existing tags (suggestions only)
//   POST /api/worker-tags { workers: [{ contactId, phone, name }], tags: ["tag", ...] }
//     -> { ok, tags, added: [{ key, name, contactId }], failed: [{ key, name, reason }], pending: [key, ...] }
// Workers with a contact id are tagged by id; workers without one are found by phone first.
// Only adds tags: the contact's other tags stay. Viewers are refused (authorizeWrite).
// Each call works for at most ~6 seconds (Netlify cuts sync functions off at 10s);
// whoever wasn't reached comes back in "pending" and the board sends them again.
// One line per call goes to Admin > Activity.
import { db, ensureSchema } from './db.mjs';
import { json, errorResponse, authorizeRead, authorizeWrite, readPayload } from '../../lib/http.mjs';
import { sessionFromRequest } from '../../lib/session.mjs';
import { StateError } from '../../lib/state.mjs';
import { logActivity } from '../../lib/activity.mjs';
import { addContactTags, listLocationTags, findContactIdByPhone } from '../../lib/ghl.mjs';
import { cleanTags, cleanWorkers, MAX_WORKERS } from '../../lib/worker-tags.mjs';

const BUDGET_MS = 6000, BATCH = 5, TAG_CACHE_MS = 10 * 60000;
let tagCache = null; // per warm instance

export default async function handler(request) {
  try {
    if (request.method === 'GET') {
      await authorizeRead(request);
      if (tagCache && Date.now() - tagCache.at < TAG_CACHE_MS) return json({ ok: true, tags: tagCache.tags });
      try {
        const tags = await listLocationTags();
        tagCache = { at: Date.now(), tags };
        return json({ ok: true, tags });
      } catch (error) {
        // Suggestions only: the board still lets dispatch type any tag.
        console.error('GHL tag list failed', error.message);
        return json({ ok: false, tags: [], error: error.status === 401 || error.status === 403 ? 'The GHL token needs locations/tags.readonly to list tags.' : 'Could not load the GHL tag list.' });
      }
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    await authorizeWrite(request);
    let session = null;
    try { session = sessionFromRequest(request); } catch { session = null; }
    const body = await readPayload(request);
    const tags = cleanTags(body.tags);
    if (!tags.length) throw new StateError('Type at least one tag.');
    const workers = cleanWorkers(body.workers);
    if (!workers.length) throw new StateError('Pick at least one laborer.');
    if (workers.length > MAX_WORKERS) throw new StateError(`Tag up to ${MAX_WORKERS} laborers at a time.`);

    const started = Date.now();
    const added = [], failed = [], done = new Set();
    let rateLimited = false, scopeError = '';
    const tagOne = async w => {
      try {
        let contactId = w.contactId;
        if (!contactId) contactId = await findContactIdByPhone(w.phone);
        if (!contactId) { failed.push({ key: w.key, name: w.name, reason: 'No GHL contact has this phone number.' }); return done.add(w.key); }
        await addContactTags(contactId, tags);
        added.push({ key: w.key, name: w.name, contactId });
        done.add(w.key);
      } catch (error) {
        if (error.status === 429) { rateLimited = true; return; } // left in pending, sent again
        if (error.status === 401 || error.status === 403) scopeError = 'GHL refused the tag. The token needs contacts.write.';
        failed.push({ key: w.key, name: w.name, reason: error.status === 404 ? 'Contact not found in GHL.' : (error.reason || error.message || 'GHL error').slice(0, 160) });
        done.add(w.key);
      }
    };
    for (let i = 0; i < workers.length && !rateLimited && !scopeError && Date.now() - started < BUDGET_MS; i += BATCH) {
      await Promise.all(workers.slice(i, i + BATCH).map(tagOne));
    }
    const pending = workers.filter(w => !done.has(w.key)).map(w => w.key);
    if (added.length) {
      const sql = db(); await ensureSchema(sql);
      await logActivity(sql, session, 'Added GHL tag', `${tags.join(', ')} on ${added.length} laborer${added.length === 1 ? '' : 's'}`,
        { tags, workers: added.map(a => ({ name: a.name, contactId: a.contactId })) });
    }
    return json({ ok: !failed.length && !pending.length, tags, added, failed, pending, ...(rateLimited ? { rateLimited: true } : {}), ...(scopeError ? { error: scopeError } : {}) });
  } catch (error) { return errorResponse(error); }
}
