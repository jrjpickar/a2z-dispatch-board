const DRIVER_LOG_WEBHOOK = "https://hook.us2.make.com/tp2wwcdltmjyi1gsrc9mhywksiygqouo";

export default async function handler(request) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const payload = await request.json();
    const upstream = await fetch(process.env.DRIVER_LOG_WEBHOOK || DRIVER_LOG_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await upstream.text();
    return new Response(body || JSON.stringify({ ok: upstream.ok }), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" }
    });
  } catch (error) {
    console.error("driver-log failed", error);
    return new Response(JSON.stringify({ error: "Driver log could not be sent" }), { status: 502, headers: { "content-type": "application/json" } });
  }
}
