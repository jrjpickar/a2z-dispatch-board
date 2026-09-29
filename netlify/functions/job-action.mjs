import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { createDispatch } from '../../lib/create.mjs';
import { fillLeadOwner } from '../../lib/ghl.mjs';
import { StateError } from '../../lib/state.mjs';
import { sessionFromRequest } from '../../lib/session.mjs';
import { publicSettings } from '../../lib/settings.mjs';
export default async function handler(request) {
  try {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    authorizeWrite(request);
    const payload = await readPayload(request);
    // Assigned User is required: the Book Job sheet pre-fills the signed-in
    // user; if the browser sent none, fall back to that user, then the env default.
    const session = sessionFromRequest(request);
    const sql = db(); await ensureSchema(sql);
    const defaults = await publicSettings(sql).catch(() => ({}));
    if (!String(payload.assignedUserId || '').trim()) {
      if (defaults.defaultAssignedUserId) payload.assignedUserId = defaults.defaultAssignedUserId;
      else if (session) Object.assign(payload, { assignedUserId: session.uid, assignedUserName: session.name });
      else if (process.env.DEFAULT_ASSIGNED_USER_ID) payload.assignedUserId = process.env.DEFAULT_ASSIGNED_USER_ID;
      else throw new StateError('Pick an Assigned User before booking.');
    }
    if (session && !payload.bookedBy) Object.assign(payload, { bookedBy: session.name, bookedByUserId: session.uid });
    const result = await createDispatch(sql, 'job', payload);
    // The booking is already confirmed at this point; owner assignment is a
    // best-effort follow-up and never fails the create. It only fills blanks,
    // so a retried request is safe to run again.
    let ownerAssignment;
    try { ownerAssignment = await fillLeadOwner(result.opportunityId, payload.assignedUserId); }
    catch (error) { console.error('Lead owner assignment failed', error); ownerAssignment = { status: 'error', error: error.message }; }
    return json({ ...result, ownerAssignment });
  } catch (error) { return errorResponse(error); }
}
