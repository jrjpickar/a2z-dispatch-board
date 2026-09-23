import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { createDispatch } from '../../lib/create.mjs';
import { fillLeadOwner } from '../../lib/ghl.mjs';
export default async function handler(request) {
  try {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    authorizeWrite(request);
    const payload = await readPayload(request);
    const sql = db(); await ensureSchema(sql);
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
