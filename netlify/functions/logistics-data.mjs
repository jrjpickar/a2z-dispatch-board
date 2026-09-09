import { searchOpportunities as searchContainerOpportunities } from '../../lib/ghl.mjs';
import { moveRecord } from '../../lib/store.mjs';
import { db, ensureSchema } from "./db.mjs";

const DEFAULT_LOCATION_ID = "QUcu2PEAxPV1sQm1GQCq";
const DEFAULT_CONTAINER_PIPELINE_ID = "F8i8hB7E5xHrJbJUXFr4";

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function standaloneMove(opportunity, pipelineId) {
  return {
    moveId: opportunity.id,
    status: opportunity.status,
    assetId: "",
    driverId: "",
    addonType: "container",
    assetName: "",
    equipment: "Container",
    loadCount: 1,
    clientName: opportunity.contact?.name || "",
    driverName: "",
    jobAddress: opportunity.name || "",
    loadNumber: 1,
    pipelineId,
    sourceType: "container",
    clientPhone: opportunity.contact?.phone || "",
    companyName: opportunity.contact?.companyName || "",
    movementType: "container_dispatch",
    monetaryValue: opportunity.monetaryValue,
    opportunityId: opportunity.id,
    requestedDate: "",
    requestedTime: "",
    pipelineStageId: opportunity.pipelineStageId,
    destinationAddress: opportunity.name || "",
    sourceOpportunityId: opportunity.id
  };
}

export default async function handler(request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const token = process.env.GHL_API_TOKEN;
  if (!token) return json({ error: "Server configuration is incomplete", missing: ["GHL_API_TOKEN"] }, 500);

  try {
    const sql = db();
    await ensureSchema(sql);
    const locationId = process.env.GHL_LOCATION_ID || DEFAULT_LOCATION_ID;
    const pipelineId = process.env.CONTAINER_PIPELINE_ID || DEFAULT_CONTAINER_PIPELINE_ID;
    const [opportunities, stateRows] = await Promise.all([
      searchContainerOpportunities(token, locationId, pipelineId),
      sql`select * from logistics_move_state order by updated_at desc`
    ]);

    const moves = new Map(opportunities.map(opportunity => {
      const move = standaloneMove(opportunity, pipelineId);
      return [String(move.moveId), move];
    }));

    for (const row of stateRows) {
      const moveId = String(row.move_id);
      const state = moveRecord(row);
      const existing = moves.get(moveId);
      moves.set(moveId, existing
        ? { ...existing, ...state }
        : {
            sourceType: state.targetType === "standalone" ? "container" : (state.sourceType || "demo"),
            ...state
          });
    }

    return json({ moves: Array.from(moves.values()) });
  } catch (error) {
    console.error("logistics-data failed", error);
    return json({ error: "Logistics data could not be loaded" }, 502);
  }
}
