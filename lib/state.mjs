// Pure mutation rules. Client snapshots never replace unrelated server fields.
export class StateError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const has = (o, k) => Object.hasOwn(o, k);
const pick = (o, fields) => Object.fromEntries(fields.filter(k => has(o, k)).map(k => [k, o[k]]));
export const TIMES = ['reportDate', 'reportTime', 'reportEndDate', 'reportEndTime'];
const DETAILS = ['jobAddress', 'clientName', 'clientPhone', 'scopeOfWork', 'toolsRequired', 'monetaryValue', 'paymentTerms', 'crewSize'];
const MOVE_META = ['sourceOpportunityId', 'opportunityId', 'jobId', 'targetType', 'sourceType', 'pipelineId', 'jobType', 'addonType', 'bookingMode'];
const MOVE_DETAILS = [...DETAILS, 'firstName', 'lastName', 'deliveryAddress', 'destinationAddress', 'pickupAddress', 'notes', 'equipment', 'containerSize', 'movementType', 'loadCount', 'loadNumber'];
const MOVE_TIMES = [...TIMES, 'requestedDate', 'requestedTime', 'scheduledDate', 'scheduledTime', 'date', 'time', 'scheduledStart'];
const emptyTimes = () => Object.fromEntries(TIMES.map(k => [k, '']));
export function normalizePayload(input) {
  const parse = value => {
    for (let n = 0; n < 3 && typeof value === 'string'; n++) {
      try { value = JSON.parse(value); } catch { break; }
    }
    return value;
  };
  const parsed = parse(input);
  if (!parsed || typeof parsed !== 'object') throw new StateError('JSON object required');
  if (Array.isArray(parsed)) return Object.assign({}, ...parsed.map(parse).filter(x => x && typeof x === 'object' && !Array.isArray(x)));
  const embedded = Object.entries(parsed).filter(([k]) => /^\d+$/.test(k)).map(([, v]) => parse(v)).filter(x => x && typeof x === 'object' && !Array.isArray(x));
  return { ...Object.assign({}, ...embedded), ...Object.fromEntries(Object.entries(parsed).filter(([k]) => !/^\d+$/.test(k))) };
}
export function normalizeCrew(value) {
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) value = parsed; } catch { /* legacy names */ }
    if (typeof value === 'string') value = value.split(';');
  }
  const result = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!item) continue;
    const worker = typeof item === 'string' ? { name: item } : item;
    const normalized = {
      id: String(worker.id || worker.contactId || ''),
      name: String(worker.name || worker.workerName || '').replace(/^[\s"'`;,:]+|[\s"'`;,:]+$/g, '').replace(/\s+/g, ' ').trim(),
      phone: String(worker.phone || worker.workerPhone || '')
    };
    if (normalized.name && !result.some(w => sameWorker(w, normalized))) result.push(normalized);
  }
  return result;
}
function sameWorker(a, b) {
  if (a.id && b.id) return a.id === b.id;
  if (a.phone && b.phone) return a.phone.replace(/\D/g, '') === b.phone.replace(/\D/g, '');
  return a.name.toLowerCase() === b.name.toLowerCase();
}
function dateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) throw new StateError('A valid date and time are required');
  const parsed = new Date(`${date}T${time}:00Z`);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) throw new StateError('Invalid calendar date');
  return +parsed;
}
function validateDetails(patch) {
  if (has(patch, 'monetaryValue') && patch.monetaryValue !== null && patch.monetaryValue !== '') {
    const n = Number(patch.monetaryValue);
    if (!Number.isFinite(n) || n < 0) throw new StateError('Job value must be a nonnegative number');
    patch.monetaryValue = n;
  }
  if (has(patch, 'crewSize') && (!Number.isInteger(Number(patch.crewSize)) || Number(patch.crewSize) < 1 || Number(patch.crewSize) > 100)) throw new StateError('Invalid crew size');
  return patch;
}
export function checkVersion(current, input) {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new StateError('Refresh this dashboard before saving (version required)', 428);
  if (input.expectedVersion !== Number(current?.version || 0)) throw new StateError('Another dispatcher changed this record. Refresh and review before saving again.', 409);
}
export function mutateJob(current, input) {
  const action = input.action || 'patch';
  const data = { ...(current?.data || {}) };
  let active = current?.active ?? true;
  if (!active && !['complete', 'cancel'].includes(action)) throw new StateError('This job is closed. Reopen it explicitly before editing.', 409);
  switch (action) {
    case 'create':
    case 'import':
      if (current) throw new StateError('This job already has shared state; import will not overwrite it.', 409);
      Object.assign(data, validateDetails(pick(input, [...TIMES, ...DETAILS, 'jobType', 'pipelineId'])));
      data.crew = normalizeCrew(input.crew ?? input.assignedWorkers ?? []);
      active = input.active !== false && input.active !== 'false';
      break;
    case 'save_times': {
      const start = dateTime(input.reportDate, input.reportTime);
      const end = dateTime(input.reportEndDate, input.reportEndTime);
      if (end <= start) throw new StateError('End time must be after start time');
      Object.assign(data, pick(input, TIMES));
      break;
    }
    case 'update_details': Object.assign(data, validateDetails(pick(input, DETAILS))); break;
    case 'assign': {
      if (!Array.isArray(input.crewChanges)) throw new StateError('Refresh the dashboard: crew changes must be sent as additions, not a snapshot.', 428);
      const additions = normalizeCrew(input.crewChanges);
      if (!additions.length) throw new StateError('At least one named worker is required');
      data.crew = normalizeCrew([...normalizeCrew(data.crew), ...additions]);
      break;
    }
    case 'remove': {
      const removals = normalizeCrew(input.removedWorkers);
      if (!removals.length) throw new StateError('Worker to remove is required');
      data.crew = normalizeCrew(data.crew).filter(w => !removals.some(r => sameWorker(w, r)));
      break;
    }
    case 'reset_dispatch': Object.assign(data, emptyTimes(), { crew: [] }); break;
    case 'complete': case 'cancel':
      Object.assign(data, { status: action === 'complete' ? 'completed' : 'cancelled', crew: [] }); active = false; break;
    case 'patch': Object.assign(data, validateDetails(pick(input, DETAILS))); break;
    default: throw new StateError('Unsupported job action');
  }
  return { data, active };
}
export function mutateMove(current, input) {
  const action = input.action || 'create';
  const data = { ...(current?.data || {}) };
  if (current && (data.active === false || /complete|cancel/.test(data.status || '')) && !['complete', 'cancel', 'release_asset'].includes(action)) throw new StateError('This move is closed.', 409);
  // Establish identity for a GHL move with no local row. Later actions cannot reparent it.
  if (!current) Object.assign(data, pick(input, MOVE_META));
  const setSchedule = () => {
    const date = input.scheduledDate ?? input.requestedDate ?? input.reportDate;
    const time = input.scheduledTime ?? input.requestedTime ?? input.reportTime;
    dateTime(date, time);
    Object.assign(data, { reportDate: date, reportTime: time, requestedDate: date, requestedTime: time, scheduledDate: date, scheduledTime: time });
  };
  switch (action) {
    case 'create': case 'create_addon': case 'import':
      if (current) throw new StateError('This move already exists; import will not overwrite it.', 409);
      Object.assign(data, validateDetails(pick(input, [...MOVE_DETAILS, ...MOVE_TIMES, 'driverId', 'driverName', 'driverPhone', 'assetId', 'assetName', 'assets', 'status'])));
      data.active = input.active !== false && input.active !== 'false';
      data.status ||= 'requested';
      break;
    case 'update_schedule': setSchedule(); data.status = data.driverName ? 'assigned' : 'scheduled'; break;
    case 'update_addon': case 'update_job':
      Object.assign(data, validateDetails(pick(input, MOVE_DETAILS))); setSchedule(); break;
    case 'assign_driver':
      if (!String(input.driverName || '').trim()) throw new StateError('Driver is required');
      Object.assign(data, pick(input, ['driverId', 'driverName', 'driverPhone']), { status: 'assigned' }); break;
    case 'remove_driver':
      Object.assign(data, { driverId: '', driverName: '', driverPhone: '', driver: null, driver_name: '', assignedDriverName: '', assigned_driver_name: '', status: data.scheduledDate ? 'scheduled' : 'requested' }); break;
    case 'assign_asset': case 'release_asset': {
      const assetId = String(input.assetId || '').trim();
      if (!assetId) throw new StateError('Asset ID is required');
      const assets = (Array.isArray(data.assets) ? data.assets : (data.assetId ? [{ assetId: data.assetId, assetName: data.assetName }] : [])).filter(a => String(a.assetId || a.id) !== assetId);
      if (action === 'assign_asset') assets.push({ assetId, assetName: input.assetName || '' });
      data.releasedAssetIds = [...new Set([...(data.releasedAssetIds || []), ...(action === 'release_asset' ? [assetId] : [])])].filter(id => action !== 'assign_asset' || id !== assetId);
      Object.assign(data, { assets, assetId: assets[0]?.assetId || '', assetName: assets[0]?.assetName || '', lowboyId: '', asset: null }); break;
    }
    case 'reset_dispatch': case 'complete': case 'cancel':
      data.releasedAssetIds = [...new Set([...(data.releasedAssetIds || []), ...(data.assets || []).map(a => String(a.assetId || a.id)), ...(data.assetId ? [String(data.assetId)] : [])])];
      Object.assign(data, Object.fromEntries(MOVE_TIMES.map(k => [k, ''])), {
        driverId: '', driverName: '', driverPhone: '', driver: null, driver_name: '', assignedDriverName: '', assigned_driver_name: '',
        assetId: '', assetName: '', assets: [], lowboyId: '', asset: null,
        status: action === 'reset_dispatch' ? 'requested' : action === 'complete' ? 'completed' : 'cancelled', active: action === 'reset_dispatch'
      }); break;
    default: throw new StateError('Unsupported logistics action');
  }
  return { data };
}
