import { db, ensureSchema } from "./db.mjs";

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function sameSiteRequest(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

function parseEmbeddedJson(value) {
  let current = value;
  for (let attempt = 0; attempt < 3 && typeof current === "string"; attempt += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  return current;
}

function normalizePayload(input) {
  const parsed = parseEmbeddedJson(input);
  if (Array.isArray(parsed)) {
    const objects = parsed
      .map(parseEmbeddedJson)
      .filter(value => value && typeof value === "object" && !Array.isArray(value));
    return Object.assign({}, ...objects);
  }
  if (!parsed || typeof parsed !== "object") return {};

  const regularEntries = Object.entries(parsed)
    .filter(([key]) => !/^\d+$/.test(key));
  const embeddedObjects = Object.entries(parsed)
    .filter(([key]) => /^\d+$/.test(key))
    .map(([, value]) => parseEmbeddedJson(value))
    .filter(value => value && typeof value === "object" && !Array.isArray(value));

  return {
    ...Object.assign({}, ...embeddedObjects),
    ...Object.fromEntries(regularEntries)
  };
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
  }

  if (!sameSiteRequest(request)) {
    return json({ error: "Cross-site request rejected" }, 403);
  }

  let payload;
  try {
    payload = normalizePayload(await request.json());
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  const jobId = String(payload.jobId || payload.opportunityId || "").trim();
  if (!jobId) {
    return json({ error: "jobId is required" }, 400);
  }

  const active = payload.active !== false && payload.active !== "false";
  const storedData = { ...payload, jobId };
  delete storedData.opportunityId;
  delete storedData.active;

  try {
    const sql = db();
    await ensureSchema(sql);
    const [row] = await sql`
      insert into job_shared_state (job_id, data, active, updated_at)
      values (${jobId}, ${sql.json(storedData)}, ${active}, now())
      on conflict (job_id) do update set
        data = case
          when jsonb_typeof(job_shared_state.data) = 'object'
            then job_shared_state.data || excluded.data
          else excluded.data
        end,
        active = excluded.active,
        updated_at = now()
      returning job_id, data, active, updated_at
    `;

    return json({
      ok: true,
      record: {
        jobId: row.job_id,
        ...row.data,
        active: row.active,
        updatedAt: row.updated_at
      }
    });
  } catch (error) {
    console.error("shared-state failed", error);
    return json({ error: "Shared state could not be saved" }, 500);
  }
}
