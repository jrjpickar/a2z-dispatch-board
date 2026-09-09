// Read-only feed for the field app: logistics routes assigned to the signed-in
// driver, and labor jobs the signed-in worker is on the crew for (with just
// their coworkers' names, not full contact detail). Only the fields someone
// on the road/job site needs leave this endpoint -- no monetary values,
// pipeline IDs, or other dispatcher-only data.
import { db, ensureSchema } from './db.mjs';
import { moveRecord, jobRecord } from '../../lib/store.mjs';
import { driverIdentityFromRequest, matchesDriver, matchesWorker, isSameIdentity } from '../../lib/driver-token.mjs';
import { json, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';

// Older moves saved before stops existed only have a single destination.
// Present that as a one-stop route so the field app never shows an empty list.
function stopsFor(move) {
  if (Array.isArray(move.stops) && move.stops.length) return move.stops;
  const address = move.destinationAddress || move.deliveryAddress || move.jobAddress || '';
  if (!address) return [];
  return [{ id: 'legacy', type: 'delivery', address, scheduledDate: '', scheduledTime: '', notes: '', completedAt: '', completedBy: '' }];
}

function driverRoute(m) {
  return {
    moveId: m.moveId,
    status: m.status || '',
    equipment: m.equipment || '',
    movementType: m.movementType || '',
    clientName: m.clientName || '',
    scheduledDate: m.scheduledDate || m.reportDate || m.requestedDate || '',
    scheduledTime: m.scheduledTime || m.reportTime || m.requestedTime || '',
    scheduledEndDate: m.reportEndDate || '',
    scheduledEndTime: m.reportEndTime || '',
    notes: m.notes || m.scopeOfWork || '',
    assetName: m.assetName || (Array.isArray(m.assets) ? m.assets.map(a => a.assetName).filter(Boolean).join(', ') : ''),
    version: m.version,
    stops: stopsFor(m)
  };
}

function workerJob(j, identity) {
  const crew = Array.isArray(j.crew) ? j.crew : [];
  return {
    jobId: j.jobId,
    jobAddress: j.jobAddress || '',
    clientName: j.clientName || '',
    scopeOfWork: j.scopeOfWork || '',
    reportDate: j.reportDate || '',
    reportTime: j.reportTime || '',
    reportEndDate: j.reportEndDate || '',
    reportEndTime: j.reportEndTime || '',
    crew: crew.filter(w => w.name).map(w => ({ name: w.name, isYou: isSameIdentity(w, identity) }))
  };
}

export default async function handler(request) {
  try {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const identity = driverIdentityFromRequest(request);
    if (!identity) throw new StateError('Sign in again', 401);
    const sql = db(); await ensureSchema(sql);
    const [moveRows, jobRows] = await Promise.all([
      sql`select * from logistics_move_state order by updated_at desc`,
      sql`select * from job_shared_state order by updated_at desc`
    ]);
    const routes = moveRows.map(moveRecord)
      .filter(m => m.active !== false && !/complete|cancel/.test(m.status || '') && matchesDriver(m, identity))
      .map(driverRoute);
    const jobs = jobRows.map(jobRecord)
      .filter(j => j.active !== false && matchesWorker(j, identity))
      .map(j => workerJob(j, identity));
    return json({ name: identity.name, routes, jobs }, 200, { 'cache-control': 'no-store' });
  } catch (error) { return errorResponse(error); }
}
