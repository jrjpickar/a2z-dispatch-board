// Field App "Request" button: a worker asks dispatch for tools or anything else.
// Free form text plus any of the special tools listed on the Daily Job Log (TOOL_GROUPS).
// Used by netlify/functions/field-request.mjs. One run per request on the worker_request webhook.
import { TOOL_GROUPS } from './job-log-doc.mjs';

export const MAX_MESSAGE = 1000;
const TZ = 'America/Los_Angeles';
const ALL_TOOLS = new Set(TOOL_GROUPS.flatMap(([, items]) => items));
export const toolGroups = () => TOOL_GROUPS.map(([group, items]) => ({ group, tools: [...items] }));

// Only tools on the job log list count (same spelling). Nothing typed: refused.
export function cleanRequest(body = {}) {
  const message = String(body.message ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim().slice(0, MAX_MESSAGE);
  const tools = [...new Set((Array.isArray(body.tools) ? body.tools : []).map(t => String(t ?? '').trim()).filter(t => ALL_TOOLS.has(t)))];
  const lang = body.lang === 'es' ? 'es' : 'en';
  if (!message && !tools.length) {
    const error = new Error(lang === 'es' ? 'Escribe lo que necesitas o elige una herramienta.' : 'Write what you need or pick a tool.');
    error.status = 400; throw error;
  }
  return { message, tools, lang };
}

const pacific = (at, options) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...options }).format(at);
// The Make run. job is the worker's job from the board ({} when they picked no job).
export function requestPayload({ identity = {}, job = {}, request, requestId, at = new Date() }) {
  const byGroup = TOOL_GROUPS.map(([group, items]) => ({ group, tools: items.filter(t => request.tools.includes(t)) })).filter(g => g.tools.length);
  return {
    action: 'workerRequest', requestId,
    workerName: identity.name || '', employeeName: identity.name || '', workerPhone: identity.phone || '',
    jobId: job.jobId || '', jobAddress: job.jobAddress || '', clientName: job.clientName || '',
    jobDate: job.reportDate || '', jobScopeOfWork: job.scopeOfWork || '',
    message: request.message,
    tools: request.tools, toolCount: request.tools.length,
    toolsText: request.tools.join(', '),
    // One line per group, e.g. "Power tools: Grinder, Generator" (handy in a Slack message).
    toolsByGroup: byGroup, toolsByGroupText: byGroup.map(g => `${g.group}: ${g.tools.join(', ')}`).join('\n'),
    language: request.lang,
    date: pacific(at, { month: '2-digit', day: '2-digit', year: 'numeric' }),
    time: pacific(at, { hour: 'numeric', minute: '2-digit' }),
    dayOfWeek: pacific(at, { weekday: 'long' }).toLowerCase(),
    requestedAt: at.toISOString(), timeZone: TZ
  };
}
