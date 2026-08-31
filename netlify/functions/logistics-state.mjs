import { db } from "./db.mjs";

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});

async function ensureLogisticsSchema(sql) {
  await sql`
    create table if not exists logistics_move_state (
      move_id text primary key,
      data jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    )
  `;
}

export default async function handler(request) {
  const sql = db();
  try {
    await ensureLogisticsSchema(sql);
    if (request.method === "GET") {
      const rows = await sql`select move_id, data, updated_at from logistics_move_state order by updated_at desc`;
      return json({ states: rows.map(row => ({ moveId: row.move_id, ...row.data, updatedAt: row.updated_at })) });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const payload = await request.json();
    const moveId = String(payload.moveId || "").trim();
    if (!moveId) return json({ error: "moveId is required" }, 400);
    const stored = { ...payload, moveId };
    const [row] = await sql`
      insert into logistics_move_state (move_id, data, updated_at)
      values (${moveId}, ${sql.json(stored)}, now())
      on conflict (move_id) do update set
        data = logistics_move_state.data || excluded.data,
        updated_at = now()
      returning move_id, data, updated_at
    `;
    return json({ ok: true, state: { moveId: row.move_id, ...row.data, updatedAt: row.updated_at } });
  } catch (error) {
    console.error("logistics-state failed", error);
    return json({ error: "Logistics state could not be saved" }, 500);
  }
}
