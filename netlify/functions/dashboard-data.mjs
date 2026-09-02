import { db, ensureSchema } from "./db.mjs";

const DEFAULTS = {
  locationId: "QUcu2PEAxPV1sQm1GQCq",
  laborPipelineId: "RAP4Cqc1jKRTHaakYTL4",
  demoPipelineId: "d5Ix1SlN3YpZ5gQewZUo",
  changeOrderPipelineId: "Nvk3EKhRzg5omo4BLCOK",
  laborStages: [
    "b3ba7011-5b50-48b1-986d-fed4281289f6",
    "6cfb3e15-0954-4f94-9f27-29f8f45b185d"
  ],
  demoStages: [
    "bb901617-1ec6-4f3c-8c77-27ccafb96404",
    "d0817d3b-89c1-49e5-bdfc-b362ee10f830"
  ]
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

async function searchOpportunities(token, locationId, pipelineId) {
  const url = new URL("https://services.leadconnectorhq.com/opportunities/search");
  url.searchParams.set("location_id", locationId);
  url.searchParams.set("pipeline_id", pipelineId);
  url.searchParams.set("status", "won");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      Accept: "application/json"
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GHL returned ${response.status}: ${text.slice(0, 180)}`);
  }

  const payload = JSON.parse(text);
  return Array.isArray(payload.opportunities) ? payload.opportunities : [];
}

function dashboardJob(opportunity, sourceType) {
  return {
    id: opportunity.id,
    name: opportunity.name,
    status: opportunity.status,
    contact: opportunity.contact,
    customFields: opportunity.customFields,
    monetaryValue: opportunity.monetaryValue,
    pipelineStageId: opportunity.pipelineStageId,
    pipelineId: opportunity.pipelineId,
    sourceType
  };
}

export default async function handler(request) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
  }

  const token = process.env.GHL_API_TOKEN;
  if (!token) {
    return json({
      error: "Server configuration is incomplete",
      missing: ["GHL_API_TOKEN"]
    }, 500);
  }

  try {
    const sql = db();
    await ensureSchema(sql);

    const locationId = process.env.GHL_LOCATION_ID || DEFAULTS.locationId;
    const laborPipelineId = process.env.LABOR_PIPELINE_ID || DEFAULTS.laborPipelineId;
    const demoPipelineId = process.env.DEMO_PIPELINE_ID || DEFAULTS.demoPipelineId;
    const changeOrderPipelineId = process.env.CHANGE_ORDER_PIPELINE_ID || DEFAULTS.changeOrderPipelineId;

    const [labor, demo, changeOrders, sharedRows] = await Promise.all([
      searchOpportunities(token, locationId, laborPipelineId),
      searchOpportunities(token, locationId, demoPipelineId),
      searchOpportunities(token, locationId, changeOrderPipelineId),
      sql`
        select job_id, data, active, updated_at
        from job_shared_state
        where active = true
        order by updated_at desc
      `
    ]);

    const laborStages = new Set(DEFAULTS.laborStages);
    const demoStages = new Set(DEFAULTS.demoStages);
    const jobs = [
      ...labor.filter(job => laborStages.has(job.pipelineStageId)).map(job => dashboardJob(job, "labor")),
      ...demo.filter(job => demoStages.has(job.pipelineStageId)).map(job => dashboardJob(job, "demo")),
      ...changeOrders.map(job => dashboardJob(job, "change_order"))
    ];

    const sharedState = sharedRows.map(row => ({
      jobId: row.job_id,
      ...row.data,
      active: row.active,
      updatedAt: row.updated_at
    }));

    return json(
      { jobs, sharedState },
      200,
      { "cache-control": "private, max-age=15" }
    );
  } catch (error) {
    console.error("dashboard-data failed", error);
    return json({ error: "Dashboard data could not be loaded" }, 502);
  }
}
