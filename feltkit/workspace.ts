/**
 * The monetized application: a small analytics workspace. Each capability declares the commercial
 * entitlement it needs and meters what it consumes, in the same transaction as the work. Nothing
 * here knows which plan a customer is on.
 */
import { fail, s } from "@feltdb/feltkit";
import { agentRuns, app, projects } from "./app.js";
import { callerAccountId, principalOf } from "./_commerce.js";
import { consume, rateLimit, requireFeature, requireLimit } from "./_metering.js";

const idempotencyKey = s.string({ minLength: 8, maxLength: 200 });

export const listProjects = app.query({
  access: "projects.read",
  returns: s.array(s.doc(projects).pick("id", "name", "createdAt", "createdBy")),
  capability: { name: "workspace.projects", description: "List the workspace's projects." },
  handler: async (ctx) => (await ctx.db.find(projects, {}, { orderBy: [{ field: "createdAt", direction: "asc" }] })).map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, createdBy: p.createdBy })),
});

/** Limited by projects.max. */
export const createProject = app.mutation({
  access: "projects.write",
  args: { name: s.string({ minLength: 1, maxLength: 80 }) },
  returns: s.string(),
  handler: async (ctx, { name }) => {
    const accountId = callerAccountId(ctx);
    await requireLimit(ctx, accountId, "projects.max", await ctx.db.count(projects, {}), 1, principalOf(ctx));
    return ctx.db.insert(projects, { name: name.trim(), createdAt: Date.now(), createdBy: principalOf(ctx).id });
  },
});

export const deleteProject = app.mutation({
  access: "projects.write",
  args: { id: s.string() },
  handler: async (ctx, { id }) => ctx.db.delete(projects, id),
});

/** One export, metered against exports.monthly. The caller's key makes a retried click count once. */
export const runExport = app.mutation({
  access: "exports.run",
  args: { projectId: s.string(), format: s.enum(["csv", "pdf"]), idempotencyKey },
  returns: s.object({ exportId: s.string(), disposition: s.string(), estimatedCost: s.integer(), duplicate: s.boolean() }),
  capability: { name: "workspace.export", description: "Export a project's report (csv or pdf). Metered: uses one export from the monthly allowance; overage follows the plan." },
  handler: async (ctx, { projectId, format, idempotencyKey: key }) => {
    const accountId = callerAccountId(ctx);
    const project = await ctx.db.get(projects, projectId);
    if (!project) fail("NOT_FOUND", "No such project in this workspace.");
    const r = await consume(ctx, { accountId, meter: "exports", quantity: 1, idempotencyKey: `export:${key}`, actor: principalOf(ctx), source: "workspace.export", resource: `project:${projectId}:${format}` });
    return { exportId: r.event.id, disposition: r.event.disposition, estimatedCost: r.event.estimatedCost, duplicate: r.duplicate };
  },
});

/** Gated by the boolean analytics.advanced. */
export const advancedAnalytics = app.query({
  access: "analytics.read",
  returns: s.object({ projects: s.integer(), cohorts: s.array(s.object({ week: s.string(), retained: s.number() })) }),
  capability: { name: "workspace.analytics", description: "Advanced analytics (cohort retention). Needs the analytics.advanced entitlement." },
  handler: async (ctx) => {
    await requireFeature(ctx, callerAccountId(ctx), "analytics.advanced", principalOf(ctx));
    const n = await ctx.db.count(projects, {});
    return { projects: n, cohorts: [0, 1, 2, 3, 4, 5].map((w) => ({ week: `W${w + 1}`, retained: Math.round(1000 * Math.pow(0.86, w) * (1 + n / 50)) / 10 })) };
  },
});

/** A public-API request: rate-limited per minute and metered per month. */
export const apiCall = app.mutation({
  access: "api.call",
  args: { endpoint: s.string({ maxLength: 120 }), idempotencyKey },
  returns: s.object({ ok: s.boolean(), disposition: s.string() }),
  capability: { name: "workspace.apicall", description: "Make one public-API request. Rate limited (per minute) and metered (per month)." },
  handler: async (ctx, { endpoint, idempotencyKey: key }) => {
    const accountId = callerAccountId(ctx);
    await rateLimit(ctx, accountId, "api.requests.per_minute");
    const r = await consume(ctx, { accountId, meter: "api.requests", quantity: 1, idempotencyKey: `api:${key}`, actor: principalOf(ctx), source: "workspace.api", resource: endpoint });
    return { ok: true, disposition: r.event.disposition };
  },
});

/**
 * Work an agent performs for the workspace. Needs agents.enabled, draws on agents.executions.monthly,
 * and any overage it causes must be within the agent's own spending authority.
 */
export const agentExecute = app.mutation({
  access: "agentruns.execute",
  args: { task: s.string({ minLength: 1, maxLength: 500 }), idempotencyKey },
  returns: s.object({ runId: s.string(), disposition: s.string(), estimatedCost: s.integer(), duplicate: s.boolean() }),
  capability: { name: "workspace.agentrun", description: "Record one agent execution for this workspace. Metered (agent.executions); overage must be within the agent's spending authority." },
  handler: async (ctx, { task, idempotencyKey: key }) => {
    const accountId = callerAccountId(ctx);
    const me = principalOf(ctx);
    if (me.type !== "agent") fail("FORBIDDEN", "Agent executions are performed by agents.");
    const r = await consume(ctx, { accountId, meter: "agent.executions", quantity: 1, idempotencyKey: `agentrun:${me.id}:${key}`, actor: me, source: "workspace.agentrun", resource: task.slice(0, 200) });
    if (r.duplicate) return { runId: r.event.resource ?? r.event.id, disposition: r.event.disposition, estimatedCost: r.event.estimatedCost, duplicate: true };
    const runId = await ctx.db.insert(agentRuns, { agentId: me.id, task, state: "done", result: `Completed: ${task}`, requestedBy: me.id, createdAt: Date.now() });
    return { runId, disposition: r.event.disposition, estimatedCost: r.event.estimatedCost, duplicate: false };
  },
});

export const listAgentRuns = app.query({
  access: "projects.read",
  handler: async (ctx) => (await ctx.db.find(agentRuns, {}, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 50 })).map((r) => ({ id: r.id, agentId: r.agentId, task: r.task, state: r.state, createdAt: r.createdAt })),
});
