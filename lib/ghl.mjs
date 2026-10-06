const ROOT = 'https://services.leadconnectorhq.com';
export async function ghl(path, options = {}) {
  const token = process.env.GHL_API_TOKEN;
  if (!token) throw new Error('GHL_API_TOKEN is missing');
  const response = await fetch(`${ROOT}${path}`, { ...options, signal: AbortSignal.timeout(12000), headers: {
    Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json', ...options.headers
  } });
  if (!response.ok) {
    // Keep GHL's own reason (e.g. duplicate phone) so the board can show it.
    let reason = '';
    try { const body = await response.json(); reason = [body.message].flat().filter(Boolean).join('; ') || body.error || ''; } catch {}
    const error = new Error(`GHL HTTP ${response.status}${reason ? ': ' + reason : ''}`);
    error.status = response.status; error.reason = String(reason);
    throw error;
  }
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

// ---------- Contact search (admin "Add worker from GHL") ----------
// Token needs contacts.readonly. Tries the v2 search endpoint, then the
// older query endpoint if the first isn't available on this token.
export function contactSummary(c) {
  const name = c.contactName || c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.phone || c.id;
  return { id: c.id, name: String(name).replace(/\s+/g, ' ').trim(), firstName: c.firstName || '', lastName: c.lastName || '', phone: c.phone || '', email: c.email || '', tags: Array.isArray(c.tags) ? c.tags.slice(0, 6) : [] };
}
// "(714) 555-0100", "714-555-0100", "17145550100" -> "+17145550100". Other
// countries must be typed with their + code. Returns '' for a blank phone.
export function normalizeContactPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  throw Object.assign(new Error('Enter a 10-digit phone number (or +country code).'), { status: 400 });
}
// Admin edit: writes first/last name and phone straight to the GHL contact.
export async function updateContactNamePhone(contactId, { firstName, lastName, phone }) {
  const body = { firstName: String(firstName || '').trim(), lastName: String(lastName || '').trim(), phone: normalizeContactPhone(phone) };
  body.name = [body.firstName, body.lastName].filter(Boolean).join(' ');
  const { contact } = await ghl(`/contacts/${encodeURIComponent(contactId)}`, { method: 'PUT', body: JSON.stringify(body) });
  return contactSummary({ ...(contact || {}), id: contact?.id || contactId, firstName: contact?.firstName ?? body.firstName, lastName: contact?.lastName ?? body.lastName, phone: contact?.phone ?? body.phone, contactName: '' , name: '' });
}
export async function searchContacts(query, limit = 20) {
  const locationId = process.env.GHL_LOCATION_ID || DEFAULT_LOCATION_ID;
  const q = String(query || '').trim().slice(0, 80);
  if (q.length < 2) return [];
  let contacts;
  try {
    const payload = await ghl('/contacts/search', { method: 'POST', body: JSON.stringify({ locationId, pageLimit: limit, query: q }) });
    contacts = payload.contacts;
  } catch (error) {
    const payload = await ghl(`/contacts/?${new URLSearchParams({ locationId, query: q, limit: String(limit) })}`);
    contacts = payload.contacts;
  }
  return (Array.isArray(contacts) ? contacts : []).filter(c => c && c.id).map(contactSummary);
}
export async function getContact(contactId) {
  const { contact } = await ghl(`/contacts/${encodeURIComponent(contactId)}`);
  if (!contact?.id) throw new Error('Contact not found');
  return contactSummary(contact);
}

// ---------- Change orders ----------
// Linking a job as a change order moves its opportunity into the Change Order
// pipeline (status stays won so it stays on the board). The stage is
// CHANGE_ORDER_STAGE_ID if set, otherwise the pipeline's first stage.
export const DEFAULT_CHANGE_ORDER_PIPELINE_ID = 'Nvk3EKhRzg5omo4BLCOK';
export const changeOrderPipelineId = () => process.env.CHANGE_ORDER_PIPELINE_ID || DEFAULT_CHANGE_ORDER_PIPELINE_ID;
async function changeOrderStageId(pipelineId) {
  if (process.env.CHANGE_ORDER_STAGE_ID) return process.env.CHANGE_ORDER_STAGE_ID;
  const locationId = process.env.GHL_LOCATION_ID || DEFAULT_LOCATION_ID;
  const payload = await ghl(`/opportunities/pipelines?${new URLSearchParams({ locationId })}`);
  const pipeline = (Array.isArray(payload.pipelines) ? payload.pipelines : []).find(p => p && p.id === pipelineId);
  const stages = Array.isArray(pipeline?.stages) ? [...pipeline.stages].sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0)) : [];
  if (!stages[0]?.id) throw new Error('Change Order pipeline has no stages in GHL (set CHANGE_ORDER_STAGE_ID)');
  return stages[0].id;
}
// Safe to call again: an opportunity already in the pipeline is left alone.
export async function moveToChangeOrderPipeline(opportunityId) {
  const pipelineId = changeOrderPipelineId();
  const { opportunity } = await ghl(`/opportunities/${encodeURIComponent(opportunityId)}`);
  if (!opportunity?.id) throw new Error('Opportunity not found in GHL');
  if (opportunity.pipelineId === pipelineId) return { status: 'already', pipelineId, pipelineStageId: opportunity.pipelineStageId };
  const pipelineStageId = await changeOrderStageId(pipelineId);
  await ghl(`/opportunities/${encodeURIComponent(opportunityId)}`, { method: 'PUT', body: JSON.stringify({ pipelineId, pipelineStageId, status: 'won' }) });
  return { status: 'moved', pipelineId, pipelineStageId, fromPipelineId: opportunity.pipelineId || '' };
}
