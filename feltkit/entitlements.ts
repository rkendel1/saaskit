/**
 * Entitlements as a contract. Applications (and agents) ask "may this account do X, and what
 * would it cost?" — never "which plan is this?". Operators grant overrides and temporary grants.
 */
import { fail, s, type QueryCtx } from "@feltdb/feltkit";
import { app, audit, grants, projects, rateWindows } from "./app.js";
import { featureOf } from "./_catalog.js";
import { callerAccountId, commercialState, principalOf } from "./_commerce.js";
import { decide } from "./_engine.js";
import { agentPolicyFor, agentSpendFor, counterFor, entitlement } from "./_metering.js";

const DecisionShape = s.object({
  feature: s.string(),
  allowed: s.boolean(),
  code: s.string(),
  reason: s.string(),
  limit: s.nullable(s.union([s.boolean(), s.number()])),
  used: s.optional(s.number()),
  reserved: s.optional(s.number()),
  remaining: s.optional(s.nullable(s.number())),
  overageUnits: s.optional(s.number()),
  estimatedCost: s.optional(s.number()),
  /** For an agent caller: whether its own spending authority covers this. */
  agent: s.optional(s.object({ authorized: s.boolean(), reason: s.string(), budgetRemaining: s.nullable(s.number()) })),
});

/** The live count a limit feature is measured against. */
async function currentCount(ctx: QueryCtx, accountId: string, feature: string): Promise<number> {
  if (feature === "projects.max") return ctx.db.count(projects, {});
  if (feature === "team.members.max") return (await ctx.tenancy.members()).filter((m) => m.type !== "agent").length;
  if (feature === "api.requests.per_minute") {
    const [w] = await ctx.db.find(rateWindows, { accountId, feature, window: Math.floor(Date.now() / 60_000) }, { limit: 1 });
    return w?.count ?? 0;
  }
  return 0;
}

export const check = app.query({
  access: "entitlements.read",
  args: { feature: s.string(), quantity: s.optional(s.number({ minimum: 0 })) },
  returns: DecisionShape,
  capability: { name: "entitlements.check", description: "Whether this account may use a feature now (and for an agent, whether its spending authority covers it), with remaining allowance and any overage cost. Read-only." },
  handler: async (ctx, { feature, quantity }) => {
    const accountId = callerAccountId(ctx);
    const actor = principalOf(ctx);
    const state = await commercialState(ctx, accountId, actor);
    const e = entitlement(state, feature);
    if (!e) return { feature, allowed: false, code: "unknown_feature", reason: `No feature "${feature}" in your catalog version.`, limit: null };
    const q = quantity ?? 1;
    let d;
    if (e.type === "allowance") {
      const c = await counterFor(ctx, accountId, e.meter!, state.periodKey);
      d = decide(e, q, { used: c?.used ?? 0, reserved: c?.reserved ?? 0 });
    } else d = decide(e, q, { count: await currentCount(ctx, accountId, feature) });
    if (actor.type !== "agent") return d;
    const policy = await agentPolicyFor(ctx, accountId, actor.id);
    if (!policy || !policy.enabled || policy.revokedAt) return { ...d, agent: { authorized: false, reason: "No spending policy for this agent.", budgetRemaining: null } };
    if (e.meter && !policy.meters.includes(e.meter)) return { ...d, agent: { authorized: false, reason: `Not allowed to consume ${e.meter}.`, budgetRemaining: null } };
    const spent = (await agentSpendFor(ctx, accountId, actor.id, state.periodKey))?.spent ?? 0;
    const cost = d.estimatedCost ?? 0;
    const remaining = policy.budgetPerPeriod - spent;
    const authorized = cost <= policy.perOperationLimit && cost <= remaining;
    return { ...d, agent: { authorized, reason: authorized ? "Within this agent's authority." : cost > policy.perOperationLimit ? "Above the per-operation limit: needs a person's approval." : "Would exceed this agent's budget for the period.", budgetRemaining: remaining } };
  },
});

export const list = app.query({
  access: "entitlements.read",
  returns: s.object({ plan: s.string(), status: s.string(), entitlements: s.array(s.object({ key: s.string(), name: s.string(), type: s.string(), value: s.nullable(s.union([s.boolean(), s.number()])), used: s.optional(s.number()), sources: s.array(s.string()) })) }),
  capability: { name: "entitlements.list", description: "Every feature, limit and allowance this account has now, with usage." },
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const state = await commercialState(ctx, accountId, principalOf(ctx));
    const out = [];
    for (const e of state.entitlements) {
      const used = e.type === "allowance" ? (await counterFor(ctx, accountId, e.meter!, state.periodKey))?.used ?? 0 : e.type === "boolean" ? undefined : await currentCount(ctx, accountId, e.key);
      out.push({ key: e.key, name: e.name, type: e.type, value: e.value, ...(used !== undefined ? { used } : {}), sources: e.sources });
    }
    return { plan: state.plan.key, status: state.sub.status, entitlements: out };
  },
});

/** Why the account has (or lacks) a feature: subscription state, plan value, grants, overrides. */
export const explain = app.query({
  access: "entitlements.read",
  args: { feature: s.string() },
  handler: async (ctx, { feature }) => explainFor(ctx, callerAccountId(ctx), feature),
});

async function explainFor(ctx: QueryCtx, accountId: string, feature: string) {
  const state = await commercialState(ctx, accountId);
  const e = entitlement(state, feature);
  if (!e) fail("NOT_FOUND", `No feature "${feature}".`);
  const rows = (await ctx.db.find(grants, { accountId })).filter((g) => g.feature === feature);
  const steps: string[] = [];
  steps.push(`Subscription is ${state.sub.status} on "${state.sub.planKey}" (catalog v${state.sub.catalogVersion}).`);
  steps.push(state.onDefault ? `A ${state.sub.status} subscription does not grant its plan; access falls back to the default plan "${state.plan.key}".` : `The plan "${state.plan.key}" grants ${JSON.stringify(e.planValue)}.`);
  for (const g of rows) {
    const live = !g.revokedAt && (g.expiresAt === undefined || g.expiresAt > Date.now()) && (g.kind !== "addon" || g.periodKey === state.periodKey);
    steps.push(`${live ? "Applies" : "Does not apply"}: ${g.kind} ${JSON.stringify(g.value)}${g.scope ? ` for ${g.scope.type} ${g.scope.id}` : ""} — ${g.reason}${g.revokedAt ? " (revoked)" : g.expiresAt && g.expiresAt <= Date.now() ? " (expired)" : g.kind === "addon" && g.periodKey !== state.periodKey ? " (earlier period)" : ""}.`);
  }
  steps.push(`Effective value: ${JSON.stringify(e.value)}.`);
  if (e.overage) steps.push(`Beyond the allowance: ${e.overage.policy}${e.overage.policy === "charge" ? ` at ${e.overage.unitAmount} per ${e.overage.perUnits}` : ""}${e.overage.hardCap !== undefined ? `, capped at ${e.overage.hardCap} extra` : ""}.`);
  return { feature, value: e.value, planValue: e.planValue, sources: e.sources, steps };
}

export const explainForAccount = app.query({
  access: "ops.read",
  args: { accountId: s.string(), feature: s.string() },
  handler: async (ctx, { accountId, feature }) => explainFor(ctx, accountId, feature),
});

/** An operator override (replaces the plan value) or grant (adds to it), optionally temporary or scoped. */
export const grant = app.mutation({
  access: "ops.entitlements",
  args: { accountId: s.string(), feature: s.string(), kind: s.enum(["override", "grant"]), value: s.union([s.boolean(), s.number({ minimum: 0 }), s.null()]), expiresAt: s.optional(s.number()), scope: s.optional(s.object({ type: s.enum(["user", "agent"]), id: s.string() })), reason: s.string({ minLength: 3, maxLength: 500 }) },
  returns: s.string(),
  handler: async (ctx, a) => {
    const state = await commercialState(ctx, a.accountId);
    const f = featureOf(state.catalog, a.feature) ?? fail("NOT_FOUND", `No feature "${a.feature}".`);
    if (f.type === "boolean" && typeof a.value !== "boolean") fail("INVALID_ARGUMENT", `${a.feature} takes true or false.`);
    if (f.type !== "boolean" && typeof a.value === "boolean") fail("INVALID_ARGUMENT", `${a.feature} takes a number (or null for unlimited).`);
    if (a.expiresAt !== undefined && a.expiresAt <= Date.now()) fail("INVALID_ARGUMENT", "expiresAt is in the past.");
    const id = await ctx.db.insert(grants, { accountId: a.accountId, feature: a.feature, kind: a.kind, value: a.value, ...(a.scope ? { scope: a.scope } : {}), ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}), reason: a.reason, createdBy: principalOf(ctx).id, createdAt: Date.now() });
    await audit.record(ctx, { subject: "entitlement", id: a.accountId, type: `entitlement.${a.kind}`, data: { feature: a.feature, value: a.value, expiresAt: a.expiresAt ?? null, scope: a.scope ?? null, reason: a.reason, grantId: id } });
    ctx.afterCommit.webhooks.emit("entitlements.changed", { accountId: a.accountId });
    return id;
  },
});

export const revoke = app.mutation({
  access: "ops.entitlements",
  args: { grantId: s.string(), reason: s.string({ minLength: 3, maxLength: 500 }) },
  handler: async (ctx, { grantId, reason }) => {
    const g = await ctx.db.get(grants, grantId);
    if (!g) fail("NOT_FOUND", "No such grant.");
    if (g.revokedAt) return;
    const who = principalOf(ctx).id;
    await ctx.db.patch(grants, g.id, { revokedAt: Date.now(), revokedBy: who });
    await audit.record(ctx, { subject: "entitlement", id: g.accountId, type: "entitlement.revoked", data: { grantId, feature: g.feature, reason } });
    ctx.afterCommit.webhooks.emit("entitlements.changed", { accountId: g.accountId });
  },
});

export const grantsForAccount = app.query({
  access: "ops.read",
  args: { accountId: s.string() },
  handler: async (ctx, { accountId }) => (await ctx.db.find(grants, { accountId })).sort((a, b) => b.createdAt - a.createdAt),
});
