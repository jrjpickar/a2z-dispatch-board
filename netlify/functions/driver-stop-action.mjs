// The one write the driver app is allowed: checking a stop complete/incomplete
// on a route already assigned to the signed-in driver. Everything else about
// the move (schedule, driver, asset, addresses) stays read-only from here.
import { db, ensureSchema } from './db.mjs';
import { json, readPayload, errorResponse } from '../../lib/http.mjs';
import { driverIdentityFromRequest, matchesDriver } from '../../lib/driver-token.mjs';
import { moveRecord, saveState } from '../../lib/store.mjs';
import { StateError } from '../../lib/state.mjs';

export default async function handler(request) {
  try {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const identity = driverIdentityFromRequest(request);
    if (!identity) throw new StateError('Sign in again', 401);
    const body = await readPayload(request);
    const moveId = String(body.moveId || '').trim();
    const stopId = String(body.stopId || '').trim();
    if (!moveId || !stopId) throw new StateError('moveId and stopId are required');
    const sql = db(); await ensureSchema(sql);
    const [row] = await sql`select * from logistics_move_state where move_id = ${moveId}`;
    if (!row) throw new StateError('Route not found', 404);
    const move = moveRecord(row);
    if (!matchesDriver(move, identity)) throw new StateError('This route is not assigned to you', 403);
    const result = await saveState(sql, 'move', {
      moveId,
      action: 'toggle_stop',
      stopId,
      completed: body.completed !== false,
      completedBy: identity.name,
      expectedVersion: move.version,
      requestId: String(body.requestId || '')
    });
    return json(result);
  } catch (error) { return errorResponse(error); }
}
