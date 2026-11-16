/** Agent economics: authorization, entitlement and spending authority are separate, and all must allow. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addAgent, api, payCheckout, rejects, RETURN, setup, startGateway, workspace } from "./helpers.ts";

test("an agent needs a workspace role, a plan that includes agents, AND a spending policy", async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t);
    const bot = await addAgent(t, accountId, "agent-ops");
    // Free plan: agents are not included, whatever the agent may call.
    await c.mutation(api.agents.setPolicy, { agentId: "agent-ops", enabled: true, budgetPerPeriod: 100, perOperationLimit: 50, meters: ["agent.executions"], mayRequestPurchases: false });
    await rejects(bot.mutation(api.workspace.agentExecute, { task: "summarize", idempotencyKey: "free-run-0001" }), "FAILED_PRECONDITION", "ENTITLEMENT");
    // Its role does not let it buy anything or change the plan.
    await rejects(bot.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN }), "FORBIDDEN");
    await rejects(bot.mutation(api.agents.setPolicy, { agentId: "agent-ops", enabled: true, budgetPerPeriod: 1e6, perOperationLimit: 1e6, meters: ["exports"], mayRequestPurchases: true }), "FORBIDDEN");
    // A person who is not an agent member cannot be given a policy.
    await rejects(c.mutation(api.agents.setPolicy, { agentId: "grace", enabled: true, budgetPerPeriod: 1, perOperationLimit: 1, meters: [], mayRequestPurchases: false }), "FAILED_PRECONDITION");
  } finally {
    await t.close();
  }
});

test("agent consumption is attributed, budgeted, approved by a person, and revocable", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const { c, accountId } = await workspace(t);
    const r = await c.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
    await payCheckout(t, gw, c, r.checkoutId!);
    const bot = await addAgent(t, accountId, "agent-ops");
    await rejects(bot.mutation(api.workspace.agentExecute, { task: "x", idempotencyKey: "nopolicy-0001" }), "FORBIDDEN", "AGENT_NO_POLICY");

    await c.mutation(api.agents.setPolicy, { agentId: "agent-ops", enabled: true, budgetPerPeriod: 30, perOperationLimit: 10, meters: ["agent.executions"], mayRequestPurchases: true });
    const authority = await bot.query(api.agents.myAuthority, {});
    assert.deepEqual([authority.enabled, authority.budgetRemaining, authority.meters], [true, 30, ["agent.executions"]]);
    // Fill the included allowance to its last unit (reported by the backend), then let the agent work.
    const backend = t.as({ id: "backend", type: "service", roles: ["usage_reporter"] }, { session: false });
    await backend.mutation(api.usage.ingest, { accountId, meter: "agent.executions", quantity: 999, idempotencyKey: "prior-runs" });
    const included = await bot.mutation(api.workspace.agentExecute, { task: "last included run", idempotencyKey: "run-incl-0001" });
    assert.deepEqual([included.disposition, included.estimatedCost], ["included", 0]);
    // Overage costs 10¢ per execution: within the per-operation limit, three fit the 30¢ budget.
    const check = await bot.query(api.entitlements.check, { feature: "agents.executions.monthly" });
    assert.deepEqual([check.code, check.estimatedCost, check.agent?.authorized, check.agent?.budgetRemaining], ["overage", 10, true, 30]);
    // Policy allows it, but no person has delegated spending at AuthBoundry yet.
    await rejects(bot.mutation(api.workspace.agentExecute, { task: "over 0", idempotencyKey: "run-over-0000" }), "FORBIDDEN", "AGENT_DELEGATION_MISSING");
    const delegation = await c.mutation(api.agents.delegateSpending, {});
    assert.equal(delegation.status, "active");
    assert.equal((await c.query(api.agents.myDelegations, {})).length, 1);
    for (let i = 0; i < 3; i++) assert.equal((await bot.mutation(api.workspace.agentExecute, { task: `over ${i}`, idempotencyKey: `run-over-000${i}` })).estimatedCost, 10);
    await rejects(bot.mutation(api.workspace.agentExecute, { task: "one too many", idempotencyKey: "run-over-0009" }), "FAILED_PRECONDITION", "AGENT_BUDGET_EXHAUSTED");
    const agents = await c.query(api.agents.overview, {});
    const ops = agents.agents.find((a) => a.agentId === "agent-ops")!;
    assert.deepEqual([ops.spent, ops.operations, ops.byMeter["agent.executions"]], [30, 4, 4]);
    // Attribution: the agent's usage names the person it answers to.
    const usage = (await c.query(api.usage.summary, {})).meters.find((m) => m.meter === "agent.executions")!;
    const row = usage.byActor.find((a) => a.actorId === "agent-ops")!;
    assert.deepEqual([row.actorType, row.onBehalfOf, row.quantity, row.cost], ["agent", "grace", 4, 30]);

    // The agent asks for capacity. It cannot approve its own request; a person can.
    const req = await bot.mutation(api.agents.requestCapacity, { addonKey: "agent-500", justification: "Quarter-end reporting needs ~400 more runs." });
    await rejects(bot.mutation(api.agents.decideRequest, { requestId: req.requestId, approve: true, returnUrl: RETURN }), "FORBIDDEN");
    const inbox = (await c.query(api.inbox.list, {})).map((n) => n.type);
    assert.ok(inbox.includes("agent.approval_requested") && inbox.includes("agent.spend"), JSON.stringify(inbox));
    const decided = await c.mutation(api.agents.decideRequest, { requestId: req.requestId, approve: true, returnUrl: RETURN });
    assert.equal(decided.state, "approved");
    await gw.settle();
    const ent = (await c.query(api.billing.summary, {}))!.entitlements.find((e) => e.key === "agents.executions.monthly")!;
    assert.equal(ent.value, 1500, "add-on granted on verified payment");
    assert.equal((await bot.mutation(api.workspace.agentExecute, { task: "now included again", idempotencyKey: "run-after-addon" })).disposition, "included");

    // Withdrawing the AuthBoundry delegation stops the next charge, even with budget left.
    await c.mutation(api.agents.setPolicy, { agentId: "agent-ops", enabled: true, budgetPerPeriod: 1000, perOperationLimit: 10, meters: ["agent.executions"], mayRequestPurchases: true });
    await backend.mutation(api.usage.ingest, { accountId, meter: "agent.executions", quantity: 600, idempotencyKey: "fill-addon" });
    assert.equal((await bot.mutation(api.workspace.agentExecute, { task: "charged", idempotencyKey: "run-charged-01" })).estimatedCost, 10);
    await c.mutation(api.agents.withdrawSpending, { delegationId: delegation.id });
    await rejects(bot.mutation(api.workspace.agentExecute, { task: "after withdraw", idempotencyKey: "run-withdrawn1" }), "FORBIDDEN", "AGENT_DELEGATION_MISSING");
    // Revoking the policy takes effect on the next call too.
    await c.mutation(api.agents.revokePolicy, { agentId: "agent-ops", reason: "project done" });
    await rejects(bot.mutation(api.workspace.agentExecute, { task: "after revoke", idempotencyKey: "run-revoked-01" }), "FORBIDDEN", "AGENT_NO_POLICY");
    const trail = await t.as("ada").query(api.ops.auditTrail, { subject: "agent", id: `${accountId}:agent-ops` });
    const spent = trail.find((e) => e.type === "agent.spent")!.data as { authorityDecisionId: string | null; delegationId: string | null };
    assert.ok(spent.authorityDecisionId && spent.delegationId === delegation.id, "each charge cites AuthBoundry's decision and the delegation");
    for (const type of ["agent.policy_granted", "agent.spent", "agent.purchase_requested", "agent.purchase_approved", "agent.policy_revoked"]) assert.ok(trail.some((e) => e.type === type), type);
  } finally {
    await gw.close();
    await t.close();
  }
});

test("a single costly operation above the per-operation limit needs a person", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const { c, accountId } = await workspace(t);
    const r = await c.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
    await payCheckout(t, gw, c, r.checkoutId!);
    const bot = await addAgent(t, accountId, "agent-bulk");
    await c.mutation(api.agents.setPolicy, { agentId: "agent-bulk", enabled: true, budgetPerPeriod: 10_000, perOperationLimit: 5, meters: ["agent.executions"], mayRequestPurchases: false });
    const backend = t.as({ id: "backend", type: "service", roles: ["usage_reporter"] }, { session: false });
    await backend.mutation(api.usage.ingest, { accountId, meter: "agent.executions", quantity: 1000, idempotencyKey: "fill" });
    await rejects(bot.mutation(api.workspace.agentExecute, { task: "costly", idempotencyKey: "costly-00001" }), "FAILED_PRECONDITION", "AGENT_APPROVAL_REQUIRED");
    await rejects(bot.mutation(api.agents.requestCapacity, { addonKey: "agent-500", justification: "please" }), "FORBIDDEN", "AGENT_NO_PURCHASE_AUTHORITY");
  } finally {
    await gw.close();
    await t.close();
  }
});
