const ROOT = 'https://services.leadconnectorhq.com';
export async function ghl(path, options = {}) {
  const token = process.env.GHL_API_TOKEN;
  if (!token) throw new Error('GHL_API_TOKEN is missing');
  const response = await fetch(`${ROOT}${path}`, { ...options, signal: AbortSignal.timeout(12000), headers: {
    Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json', ...options.headers
  } });
  if (!response.ok) throw new Error(`GHL HTTP ${response.status}`);
  return response.json();
}
export async function searchOpportunities(token, locationId, pipelineId) {
  const found = new Map();
  for (let page = 1; page <= 100; page++) {
    const params = new URLSearchParams({ location_id: locationId, pipeline_id: pipelineId, status: 'won', limit: '100', page: String(page) });
    const payload = await ghl(`/opportunities/search?${params}`);
    if (!Array.isArray(payload.opportunities)) throw new Error('GHL returned an invalid opportunity list');
    const count = found.size;
    payload.opportunities.forEach(o => { if (o.id) found.set(o.id, o); });
    if (payload.opportunities.length < 100 || (payload.meta?.total != null && found.size >= Number(payload.meta.total))) return [...found.values()];
    if (found.size === count) throw new Error('GHL pagination did not advance');
  }
  throw new Error('GHL pagination limit exceeded; refusing to return a partial board');
}
export function scheduleFields(data) {
  const ids = {
    reportDate: process.env.REPORT_DATE_FIELD_ID || 'rY3IebKlcBhAjWlaSSQm',
    reportTime: process.env.REPORT_TIME_FIELD_ID || 'WtpFGtiB7hgmTGTsHJAW',
    reportEndDate: process.env.REPORT_END_DATE_FIELD_ID || 'gPo421cmQiTMJP2EpkD4',
    reportEndTime: process.env.REPORT_END_TIME_FIELD_ID || 'XHoqx1ZNRcNRtwDCb4He'
  };
  return Object.entries(ids).map(([key, id]) => ({ id, field_value: data[key] || '' }));
}
export async function syncJobSchedule(sql, jobId) {
  // Serialize the external PUT with saves/retries. The dispatch commit already succeeded.
  return sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`job:${jobId}`}, 0))`;
    const [sync] = await tx`select * from dispatch_crm_sync where job_id = ${jobId}`;
    if (!sync?.pending) return { ok: true };
    const [row] = await tx`select data from job_shared_state where job_id = ${jobId}`;
    try {
      await ghl(`/opportunities/${encodeURIComponent(jobId)}`, { method: 'PUT', body: JSON.stringify({ customFields: scheduleFields(row.data) }) });
      await tx`update dispatch_crm_sync set pending = false, last_error = null, updated_at = now() where job_id = ${jobId}`;
      return { ok: true };
    } catch (error) {
      await tx`update dispatch_crm_sync set last_error = ${error.message}, updated_at = now() where job_id = ${jobId}`;
      return { ok: false, error: 'Dispatch saved. GHL schedule sync needs a retry.' };
    }
  });
}

// ---------- Lead owner (GHL assigned user) ----------
const DEFAULT_LOCATION_ID = 'QUcu2PEAxPV1sQm1GQCq';
export async function listLocationUsers() {
  const locationId = process.env.GHL_LOCATION_ID || DEFAULT_LOCATION_ID;
  // Location users endpoint; token needs the users.readonly scope.
  const payload = await ghl(`/users/?${new URLSearchParams({ locationId })}`, { headers: { Version: '2021-07-28' } });
  return (Array.isArray(payload.users) ? payload.users : [])
    .filter(u => u && u.id && !u.deleted)
    .map(u => ({ id: u.id, name: u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id, email: u.email || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
// Called after a booking returns its opportunity ID. Only fills blanks:
// a contact that already has an owner keeps them, and the opportunity gets
// whoever ends up owning the contact if it has no assignee of its own.
export async function fillLeadOwner(opportunityId, requestedUserId) {
  const userId = String(requestedUserId || process.env.DEFAULT_ASSIGNED_USER_ID || '').trim();
  if (!userId) return { status: 'skipped', reason: 'no user selected' };
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(userId)) return { status: 'skipped', reason: 'invalid user id' };
  const { opportunity } = await ghl(`/opportunities/${encodeURIComponent(opportunityId)}`);
  const contactId = opportunity?.contactId || opportunity?.contact?.id || '';
  const result = { status: 'ok', contact: 'unchanged', opportunity: 'unchanged', contactId };
  let owner = opportunity?.assignedTo || '';
  if (contactId) {
    const { contact } = await ghl(`/contacts/${encodeURIComponent(contactId)}`);
    if (contact?.assignedTo) owner = contact.assignedTo;
    else {
      await ghl(`/contacts/${encodeURIComponent(contactId)}`, { method: 'PUT', body: JSON.stringify({ assignedTo: userId }) });
      result.contact = 'assigned';
      owner = userId;
    }
  }
  if (!opportunity?.assignedTo) {
    await ghl(`/opportunities/${encodeURIComponent(opportunityId)}`, { method: 'PUT', body: JSON.stringify({ assignedTo: owner || userId }) });
    result.opportunity = 'assigned';
  }
  result.assignedTo = owner || userId;
  return result;
}
