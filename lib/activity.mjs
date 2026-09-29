// Senior admin activity log: who did what to whom, and when.
export async function logActivity(sql, session, action, target = '', detail = {}) {
  try {
    await sql`insert into dispatch_activity (actor_id, actor_name, action, target, detail)
      values (${session?.uid || ''}, ${session?.name || ''}, ${action}, ${String(target || '').slice(0, 200)}, ${sql.json(detail || {})})`;
  } catch (error) { console.error('Activity log write failed', error); } // never blocks the real action
}
export async function recentActivity(sql, limit = 200) {
  return sql`select id, at, actor_name as "actor", action, target, detail from dispatch_activity order by at desc, id desc limit ${limit}`;
}
// Send history: every EOD sheet and Project Schedule PDF sent to Make.
export async function logSend(sql, { kind, jobId, jobName, fileName, status, detail = '' }) {
  try {
    await sql`insert into dispatch_send_log (kind, job_id, job_name, file_name, status, detail)
      values (${kind}, ${String(jobId || '')}, ${String(jobName || '').slice(0, 200)}, ${String(fileName || '').slice(0, 200)}, ${status}, ${String(detail || '').slice(0, 300)})`;
  } catch (error) { console.error('Send log write failed', error); }
}
export async function sendHistory(sql, limit = 500) {
  return sql`select id, at, kind, job_id as "jobId", job_name as "jobName", file_name as "fileName", status, detail from dispatch_send_log order by at desc, id desc limit ${limit}`;
}
