import { cachedGhlJobs } from '../../lib/feed-cache.mjs';
import { searchOpportunities, changeOrderPipelineId as configuredChangeOrderPipelineId } from '../../lib/ghl.mjs';
import { jobRecord } from '../../lib/store.mjs';
import { db, ensureSchema } from "./db.mjs";

const DEFAULTS = {
  locationId: "QUcu2PEAxPV1sQm1GQCq",
  laborPipelineId: "RAP4Cqc1jKRTHaakYTL4",
  demoPipelineId: "d5Ix1SlN3YpZ5gQewZUo",
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

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter(job => job.id && !seen.has(job.id) && seen.add(job.id));
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
    const changeOrderPipelineId = configuredChangeOrderPipelineId();
    // ?fresh=1 (the board's Refresh button and its own saves) skips the shared cache.
    const fresh = new URL(request.url).searchParams.get('fresh') === '1';

    const jobs = await cachedGhlJobs(sql, fresh, async () => {
      const laborStages = new Set(DEFAULTS.laborStages);
      const demoStages = new Set(DEFAULTS.demoStages);
      // One search per active stage (not every won job ever in the pipeline).
      const [labor, demo, changeOrders] = await Promise.all([
        Promise.all(DEFAULTS.laborStages.map(stage => searchOpportunities(token, locationId, laborPipelineId, stage))).then(lists => lists.flat()),
        Promise.all(DEFAULTS.demoStages.map(stage => searchOpportunities(token, locationId, demoPipelineId, stage))).then(lists => lists.flat()),
        searchOpportunities(token, locationId, changeOrderPipelineId)
      ]);
      return dedupe([
        ...labor.filter(job => laborStages.has(job.pipelineStageId)).map(job => dashboardJob(job, "labor")),
        ...demo.filter(job => demoStages.has(job.pipelineStageId)).map(job => dashboardJob(job, "demo")),
        ...changeOrders.map(job => dashboardJob(job, "change_order"))
      ]);
    });

    // Only the records the board needs: open jobs, jobs GHL still lists (even if
    // closed on the board), and change orders linked to a job on the board.
    // Old closed jobs load on the Completed tab (/api/shared-state?view=closed).
    const ids = jobs.map(job => job.id).filter(Boolean);
    const idList = ids.length ? ids : [''];
    const [{ now }] = await sql`select now() as now`;
    const sharedRows = await sql`
      select *
      from job_shared_state
      where active = true or job_id = any(${idList}) or data->>'parentJobId' = any(${idList})
      order by updated_at desc
    `;

    return json(
      { jobs, sharedState: sharedRows.map(jobRecord), serverTime: new Date(now).toISOString() },
      200,
      { "cache-control": "no-store" }
    );
  } catch (error) {
    console.error("dashboard-data failed", error);
    return json({ error: "Dashboard data could not be loaded" }, 502);
  }
}
