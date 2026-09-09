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
