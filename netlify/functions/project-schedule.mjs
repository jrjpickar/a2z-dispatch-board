// Project Schedule (Contract jobs).
//   GET  /api/project-schedule                      -> { schedules: [...] } every saved schedule
//   GET  /api/project-schedule?blank=1              -> blank PDF form for filling in by hand
//   GET  /api/project-schedule?jobId=...&pdf=1      -> PDF of that job's saved schedule
//   POST /api/project-schedule { action: "save",   expectedVersion, jobId, start, mode, phases: [{ name, scope, crew, days, loads, startDay }], ... }
//   POST /api/project-schedule { action: "submit", ... } -> save, draw the PDF, send it to Make
// Make receives multipart/form-data: the PDF as binary in field "file", plus flat fields.
import { db, ensureSchema } from './db.mjs';
import { json, authorizeWrite, readPayload, errorResponse } from '../../lib/http.mjs';
import { StateError } from '../../lib/state.mjs';
import {
  normalizeScheduleInput, projectSchedulePdf, scheduleFileName, sendProjectSchedule,
  listProjectSchedules, getProjectSchedule, saveProjectSchedule, markProjectScheduleSent
} from '../../lib/project-schedule.mjs';

const pdfResponse = (bytes, fileName) => new Response(bytes, { headers: {
  'content-type': 'application/pdf', 'cache-control': 'no-store',
  'content-disposition': `inline; filename="${fileName.replace(/"/g, '')}"`
} });

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.searchParams.get('blank') != null) {
      return pdfResponse(await projectSchedulePdf(normalizeScheduleInput({}), { blank: true }), 'Project Schedule - Blank.pdf');
    }
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    const sql = db(); await ensureSchema(sql);

    if (request.method === 'GET') {
      const jobId = url.searchParams.get('jobId');
      if (jobId && url.searchParams.get('pdf') != null) {
        const record = await getProjectSchedule(sql, jobId);
        if (!record) return json({ error: 'No Project Schedule saved for this job yet.' }, 404);
        const input = normalizeScheduleInput(record.input);
        return pdfResponse(await projectSchedulePdf(input), scheduleFileName(input));
      }
      return json({ schedules: await listProjectSchedules(sql) });
    }

    authorizeWrite(request);
    const payload = await readPayload(request);
    const action = payload.action === 'submit' ? 'submit' : 'save';
    const input = normalizeScheduleInput(payload);
    if (!input.jobId) throw new StateError('jobId required');
    if (action === 'submit') {
      if (!input.phases.some(p => p.on)) throw new StateError('Turn on at least one phase.');
    }
    let record = await saveProjectSchedule(sql, input, payload.expectedVersion);
    if (action === 'submit') {
      try {
        const sent = await sendProjectSchedule(input);
        record = await markProjectScheduleSent(sql, input.jobId, sent.fileName);
      } catch (error) {
        // The schedule is saved either way; hand back the new version with the error.
        return json({ error: error.message, record }, error.status || 502);
      }
    }
    return json({ ok: true, record });
  } catch (error) { return errorResponse(error); }
}
