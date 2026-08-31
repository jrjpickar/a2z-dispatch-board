const DEFAULT_CONTAINER_WEBHOOK = "https://hook.us2.make.com/30np7d1bieaapqcluxlkxdgbg8l5pw2w";

function response(body, status = 200, contentType = "application/json") {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store"
    }
  });
}

export default async function handler(request) {
  if (request.method !== "POST") return response(JSON.stringify({ error: "Method not allowed" }), 405);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return response(JSON.stringify({ error: "Request body must be valid JSON" }), 400);
  }

  const allowedActions = new Set(["create", "update_job", "complete", "cancel"]);
  if (!allowedActions.has(String(payload.action || ""))) {
    return response(JSON.stringify({ error: "Unsupported container action" }), 400);
  }

  // This endpoint is exclusively for standalone container opportunities.
  payload.targetType = "standalone";
  payload.bookingMode = "standalone";
  payload.jobType = "container";
  payload.sourceType = "container";

  try {
    const upstream = await fetch(process.env.BOOK_CONTAINER_WEBHOOK || DEFAULT_CONTAINER_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await upstream.text();
    return response(body || JSON.stringify({ ok: upstream.ok, action: payload.action }), upstream.status, upstream.headers.get("content-type") || "application/json");
  } catch (error) {
    console.error("container-action failed", error);
    return response(JSON.stringify({ error: "Container action could not reach Make" }), 502);
  }
}
