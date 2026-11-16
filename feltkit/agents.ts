/**
 * Agent economics. Three things are separate and all must allow:
 *   1. application authorization — the agent's workspace role grants the capability (FeltKit roles);
 *   2. commercial entitlement   — the account bought it (the engine);
 *   3. spending authority       — a person gave THIS agent a policy: which meters, what budget,
 *                                 what single-operation limit (this module).
 * An agent can request a purchase; only a person with billing.manage can approve it.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { agentPolicies, agentSpend, app, audit, spendRequests, usageEvents } from "./app.js";
import { callerAccountId, catalogAt, commercialState, getAccount, notify, principalOf, requireSubscription } from "./_commerce.js";
import { purchaseAddonFor } from "./_lifecycle.js";
import { AGENT_SPEND_CAPABILITY, agentPolicyFor, agentSpendFor } from "./_metering.js";

/** Grant or change an agent's spending authority. The agent must be a member of this workspace. */
export const setPolicy = app.mutation({
  access: "agents.manage",
  args: {
    agentId: s.string(),
    enabled: s.boolean(),
    budgetPerPeriod: s.integer({ minimum: 0, maximum: 100_000_000 }),
    perOperationLimit: s.integer({ minimum: 0, maximum: 100_000_000 }),
    meters: s.array(s.string()),
    mayRequestPurchases: s.boolean(),
  },
  returns: s.string(),
  handler: async (ctx, a) => {
    const accountId = callerAccountId(ctx);
    const who = principalOf(ctx);
    if (who.type !== "user") fail("FORBIDDEN", "Only a person grants spending authority.");
    const member = (await ctx.tenancy.members()).find((m) => m.principalId === a.agentId);
    if (!member || member.type !== "agent") fail("FAILED_PRECONDITION", `${a.agentId} is not an agent in this workspace.`);
    const state = await commercialState(ctx, accountId);
    for (const m of a.meters) if (!state.catalog.meters.some((x) => x.key === m)) fail("INVALID_ARGUMENT", `No meter "${m}".`);
    if (a.perOperationLimit > a.budgetPerPeriod) fail("INVALID_ARGUMENT", "The per-operation limit cannot exceed the budget.");
    const existing = await agentPolicyFor(ctx, accountId, a.agentId);
    const now = Date.now();
    const fields = { enabled: a.enabled, budgetPerPeriod: a.budgetPerPeriod, perOperationLimit: a.perOperationLimit, meters: a.meters, mayRequestPurchases: a.mayRequestPurchases, principalOwner: who.id, updatedBy: who.id, updatedAt: now, revokedAt: undefined };
    const id = existing ? (await ctx.db.patch(agentPolicies, existing.id, fields), existing.id) : await ctx.db.insert(agentPolicies, { accountId, agentId: a.agentId, ...fields, revokedAt: undefined });
    await audit.record(ctx, { subject: "agent", id: `${accountId}:${a.agentId}`, type: existing ? "agent.policy_changed" : "agent.policy_granted", data: { enabled: a.enabled, budgetPerPeriod: a.budgetPerPeriod, perOperationLimit: a.perOperationLimit, meters: a.meters, mayRequestPurchases: a.mayRequestPurchases, principalOwner: who.id } });
    return id;
  },
});

export const revokePolicy = app.mutation({
  access: "agents.manage",
  args: { agentId: s.string(), reason: s.optional(s.string({ maxLength: 500 })) },
  handler: async (ctx, { agentId, reason }) => {
    const accountId = callerAccountId(ctx);
    const p = await agentPolicyFor(ctx, accountId, agentId);
    if (!p || p.revokedAt) return;
    await ctx.db.patch(agentPolicies, p.id, { enabled: false, revokedAt: Date.now(), updatedBy: principalOf(ctx).id, updatedAt: Date.now() });
    await audit.record(ctx, { subject: "agent", id: `${accountId}:${agentId}`, type: "agent.policy_revoked", data: { reason: reason ?? null } });
  },
});

/** Agents in the workspace, their authority, and what they consumed and spent this period. */
export const overview = app.query({
  access: "billing.read",
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const state = await commercialState(ctx, accountId);
    const members = (await ctx.tenancy.members()).filter((m) => m.type === "agent");
    const policies = await ctx.db.find(agentPolicies, { accountId });
    const spend = await ctx.db.find(agentSpend, { accountId, periodKey: state.periodKey });
    const events = (await ctx.db.find(usageEvents, { accountId, periodKey: state.periodKey })).filter((e) => e.agentId);
    const requests = await ctx.db.find(spendRequests, { accountId }, { orderBy: [{ field: "requestedAt", direction: "desc" }], limit: 50 });
    const ids = new Set([...members.map((m) => m.principalId), ...policies.map((p) => p.agentId)]);
    return {
      agentsEnabled: state.entitlements.find((e) => e.key === "agents.enabled")?.value === true,
      agents: [...ids].map((agentId) => {
        const p = policies.find((x) => x.agentId === agentId);
        const sp = spend.find((x) => x.agentId === agentId);
        const mine = events.filter((e) => e.agentId === agentId);
        const byMeter: Record<string, number> = {};
        for (const e of mine) byMeter[e.meter] = (byMeter[e.meter] ?? 0) + e.quantity;
        return {
          agentId, displayName: members.find((m) => m.principalId === agentId)?.displayName ?? agentId, member: members.some((m) => m.principalId === agentId),
          policy: p ? { enabled: p.enabled && !p.revokedAt, budgetPerPeriod: p.budgetPerPeriod, perOperationLimit: p.perOperationLimit, meters: p.meters, mayRequestPurchases: p.mayRequestPurchases, principalOwner: p.principalOwner, revokedAt: p.revokedAt ?? null } : null,
          spent: sp?.spent ?? 0, operations: sp?.operations ?? 0, byMeter,
        };
      }),
      requests: requests.map((r) => ({ id: r.id, agentId: r.agentId, addonKey: r.addonKey, amount: r.amount, justification: r.justification, state: r.state, requestedAt: r.requestedAt, decidedBy: r.decidedBy ?? null, invoiceId: r.invoiceId ?? null })),
    };
  },
});

/** For an agent: its own commercial authority, discoverable before it acts. */
export const myAuthority = app.query({
  access: "agents.self",
  returns: s.object({ accountId: s.string(), agentId: s.string(), enabled: s.boolean(), meters: s.array(s.string()), budgetPerPeriod: s.integer(), spent: s.integer(), budgetRemaining: s.integer(), perOperationLimit: s.integer(), mayRequestPurchases: s.boolean(), addons: s.array(s.object({ key: s.string(), name: s.string(), unitAmount: s.integer(), currency: s.string() })) }),
  capability: { name: "agents.authority", description: "This agent's spending authority in the current workspace: allowed meters, budget, what is left, and purchasable capacity." },
  handler: async (ctx) => {
    const accountId = callerAccountId(ctx);
    const me = principalOf(ctx);
    const state = await commercialState(ctx, accountId, me);
    const p = await agentPolicyFor(ctx, accountId, me.id);
    const spent = (await agentSpendFor(ctx, accountId, me.id, state.periodKey))?.spent ?? 0;
    const enabled = Boolean(p && p.enabled && !p.revokedAt);
    return {
      accountId, agentId: me.id, enabled, meters: enabled ? p!.meters : [], budgetPerPeriod: p?.budgetPerPeriod ?? 0, spent, budgetRemaining: enabled ? Math.max(p!.budgetPerPeriod - spent, 0) : 0,
      perOperationLimit: p?.perOperationLimit ?? 0, mayRequestPurchases: Boolean(enabled && p!.mayRequestPurchases),
      addons: state.catalog.addons.map((a) => ({ key: a.key, name: a.name, unitAmount: a.unitAmount, currency: a.currency })),
    };
  },
});

/** An agent asks for more capacity. Nothing is bought until a person approves. */
export const requestCapacity = app.mutation({
  access: "capacity.request",
  args: { addonKey: s.string(), justification: s.string({ minLength: 3, maxLength: 1000 }) },
  returns: s.object({ requestId: s.string(), state: s.string() }),
  capability: { name: "capacity.request", description: "Ask the workspace's billing owner to buy an add-on. Requires a person's approval; never charges by itself." },
  handler: async (ctx, { addonKey, justification }) => {
    const accountId = callerAccountId(ctx);
    const me = principalOf(ctx);
    const p = await agentPolicyFor(ctx, accountId, me.id);
    if (me.type === "agent" && (!p || !p.enabled || p.revokedAt || !p.mayRequestPurchases)) fail("FORBIDDEN", "This agent may not request purchases.", { hint: "AGENT_NO_PURCHASE_AUTHORITY" });
    const sub = await requireSubscription(ctx, accountId);
    const addon = (await catalogAt(ctx, sub.catalogVersion)).addons.find((a) => a.key === addonKey) ?? fail("NOT_FOUND", `No add-on "${addonKey}".`);
    const pending = (await ctx.db.find(spendRequests, { accountId, state: "pending" })).find((r) => r.agentId === me.id && r.addonKey === addonKey);
    if (pending) return { requestId: pending.id, state: "pending" };
    const id = await ctx.db.insert(spendRequests, { accountId, agentId: me.id, addonKey, amount: addon.unitAmount, justification, state: "pending", requestedAt: Date.now() });
    await audit.record(ctx, { subject: "agent", id: `${accountId}:${me.id}`, type: "agent.purchase_requested", data: { requestId: id, addonKey, amount: addon.unitAmount } });
    const account = (await getAccount(ctx, accountId))!;
    notify(ctx, account, "agent.approval_requested", `${me.id} asks to buy ${addon.name}`, { requestId: id, agentId: me.id, amount: addon.unitAmount, justification }, id, p ? [p.principalOwner] : []);
    return { requestId: id, state: "pending" };
  },
});

/** A person approves (the purchase is made, as them) or rejects an agent's request. */
export const decideRequest = app.mutation({
  access: "billing.manage",
  args: { requestId: s.string(), approve: s.boolean(), returnUrl: s.string({ minLength: 8 }) },
  returns: s.object({ state: s.string(), invoiceId: s.optional(s.string()), checkoutId: s.optional(s.string()) }),
  handler: async (ctx, { requestId, approve, returnUrl }) => {
    const accountId = callerAccountId(ctx);
    const who = principalOf(ctx);
    if (who.type !== "user") fail("FORBIDDEN", "Only a person approves spending.", { hint: "PERSON_REQUIRED" });
    const r = await ctx.db.get(spendRequests, requestId);
    if (!r || r.accountId !== accountId) fail("NOT_FOUND", "No such request.");
    if (r.state !== "pending") fail("FAILED_PRECONDITION", `The request is already ${r.state}.`);
    const now = Date.now();
    if (!approve) {
      await ctx.db.patch(spendRequests, r.id, { state: "rejected", decidedBy: who.id, decidedAt: now });
      await audit.record(ctx, { subject: "agent", id: `${accountId}:${r.agentId}`, type: "agent.purchase_rejected", data: { requestId } });
      return { state: "rejected" };
    }
    const result = await purchaseAddonFor(ctx, accountId, r.addonKey, who.id, returnUrl);
    await ctx.db.patch(spendRequests, r.id, { state: "approved", decidedBy: who.id, decidedAt: now, invoiceId: result.invoiceId });
    await audit.record(ctx, { subject: "agent", id: `${accountId}:${r.agentId}`, type: "agent.purchase_approved", data: { requestId, invoiceId: result.invoiceId, approvedBy: who.id } });
    return { state: "approved", invoiceId: result.invoiceId, ...(result.checkoutId ? { checkoutId: result.checkoutId } : {}) };
  },
});

// ─── Delegated spending authority (AuthBoundry) ─────────────────────────────────────────────────

/**
 * The person's own consent, held by AuthBoundry: agents may incur charges on their behalf. Without
 * it no agent policy can spend money for them; withdrawing it stops the very next charge.
 */
export const delegateSpending = app.mutation({
  access: "agents.manage",
  args: { expiresAt: s.optional(s.number()) },
  returns: s.object({ id: s.string(), status: s.string(), expiresAt: s.nullable(s.number()) }),
  handler: async (ctx, { expiresAt }) => {
    const who = principalOf(ctx);
    if (who.type !== "user") fail("FORBIDDEN", "Only a person delegates spending authority.", { hint: "PERSON_REQUIRED" });
    const g = await ctx.authority.grants.grant({ capabilities: [AGENT_SPEND_CAPABILITY], ...(expiresAt ? { expiresAt } : {}) });
    await audit.record(ctx, { subject: "agent", id: `${callerAccountId(ctx)}:*`, type: "agent.spending_delegated", data: { delegationId: g.id, by: who.id, expiresAt: g.expiresAt } });
    return { id: g.id, status: g.status, expiresAt: g.expiresAt };
  },
});

export const withdrawSpending = app.mutation({
  access: "agents.manage",
  args: { delegationId: s.string() },
  handler: async (ctx, { delegationId }) => {
    await ctx.authority.grants.revoke(delegationId);
    await audit.record(ctx, { subject: "agent", id: `${callerAccountId(ctx)}:*`, type: "agent.spending_withdrawn", data: { delegationId, by: principalOf(ctx).id } });
  },
});

/** The caller's own delegations at AuthBoundry. */
export const myDelegations = app.query({
  access: "billing.read",
  handler: async (ctx) => {
    // Workaround W-04: QueryCtx does not declare `authority`, though the runtime provides it to queries.
    const all = await (ctx as unknown as MutationCtx).authority.grants.list();
    return all.filter((g) => g.capabilities.includes(AGENT_SPEND_CAPABILITY));
  },
});
