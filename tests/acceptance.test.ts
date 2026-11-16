/**
 * The required acceptance demonstration (mission §17), as one executable scenario. Each step asserts
 * its outcome and is written to docs/evidence/acceptance-transcript.md. Stripe is the local
 * Stripe-compatible simulator behind the real payments component (test mode, no real money).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { addAgent, api, payCheckout, rejects, RETURN, setup, startGateway, workspace } from "./helpers.ts";

test("acceptance: build, sell, meter, bill, delegate, upgrade, cancel — all auditable", async () => {
  const lines: string[] = [];
  const step = (n: number, title: string, evidence: unknown) => lines.push(`| ${n} | ${title} | ${String(typeof evidence === "string" ? evidence : JSON.stringify(evidence)).replace(/\|/g, "\\|").slice(0, 400)} |`);
  const t = await setup();
  const gw = await startGateway(t);
  const ada = t.as("ada");
  try {
    // 1. The application exists: its functions, published capabilities and component.
    const status = (await gw.get("/stripe/status")).body;
    step(1, "A developer creates a SaaS application", `FeltKit app "${t.runtime.app.name}" on one FeltDB instance; payments component ${status.provider}/${status.mode}`);

    // 2–3. Free, Pro and Business with features, limits and allowances (the seed catalog, published as v1).
    const offer = await t.as("grace").query(api.catalog.offer, {});
    assert.deepEqual(offer.catalog!.plans.map((p) => p.key), ["free", "pro", "business"]);
    step(2, "Configure Free, Pro and Business", offer.catalog!.plans.map((p) => `${p.name}: ${p.prices.map((x) => `${x.unitAmount / 100} ${x.currency}/${x.interval}${x.model === "per_seat" ? "/seat" : ""}`).join(", ")}`).join("; "));
    const pro = offer.catalog!.plans.find((p) => p.key === "pro")!;
    step(3, "Configure features, limits and allowances", `${offer.catalog!.features.length} features; Pro: exports.monthly=${pro.entitlements["exports.monthly"]}, projects.max=${pro.entitlements["projects.max"]}, overage exports ${pro.overage.find((o) => o.meter === "exports")!.unitAmount}¢/unit`);

    // 4. Stripe as the provider.
    assert.equal(status.provider, "stripe");
    const health = await gw.host.health();
    assert.equal(health.components.payments!.state, "ready");
    step(4, "Configure Stripe as the payment provider", `component health ${health.status}; ${health.components.payments!.detail}`);

    // 5–6. A customer registers, selects Pro and completes checkout.
    const { c, accountId } = await workspace(t, "grace", "Acme Analytics");
    const q = await c.query(api.billing.quote, { planKey: "pro", priceKey: "pro-monthly" });
    const buy = await c.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
    assert.equal((await c.query(api.billing.summary, {}))!.subscription.planKey, "free", "nothing changes before payment");
    step(5, "A customer registers and selects Pro", `workspace ${accountId}; quote ${q.total / 100} ${q.currency}; invoice ${buy.invoiceId}; still Free until paid`);
    const paid = await payCheckout(t, gw, c, buy.checkoutId!);
    step(6, "The customer completes checkout", `hosted checkout (simulated Stripe) → ${paid.status}`);

    // 7. The verified provider event is processed.
    const events = await ada.query(api.ops.events, {});
    const applied = events.filter((e) => e.accountId === accountId && e.outcome === "applied").map((e) => e.type);
    assert.ok(applied.includes("payment_intent.succeeded"));
    step(7, "The verified payment event is processed", `Stripe-Signature verified by the component; applied: ${applied.join(", ")}`);

    // 8–9. Active, with Pro's entitlements.
    const s1 = (await c.query(api.billing.summary, {}))!;
    assert.deepEqual([s1.subscription.planKey, s1.subscription.status], ["pro", "active"]);
    step(8, "The subscription becomes active", `${s1.subscription.planKey} ${s1.subscription.status}, period ${new Date(s1.subscription.currentPeriodStart).toISOString().slice(0, 10)}→${new Date(s1.subscription.currentPeriodEnd).toISOString().slice(0, 10)}`);
    const ents = await c.query(api.entitlements.list, {});
    assert.equal(ents.entitlements.find((e) => e.key === "analytics.advanced")!.value, true);
    step(9, "The correct entitlements are granted", ents.entitlements.map((e) => `${e.key}=${JSON.stringify(e.value)}`).join(", "));

    // 10. Access enforcement: roles (application authorization), entitlements, AuthBoundry.
    await t.tenancy!.provision({ tenantId: accountId, principal: { id: "marie", type: "user" }, role: "member" }, "ada");
    const marie = t.as({ id: "marie", type: "user", roles: ["person"] }, { tenant: accountId });
    await marie.query(api.workspace.advancedAnalytics, {});
    await rejects(marie.mutation(api.billing.cancel, {}), "FORBIDDEN");
    const free = await workspace(t, "linus", "Globex");
    await rejects(free.c.query(api.workspace.advancedAnalytics, {}), "FAILED_PRECONDITION", "ENTITLEMENT");
    step(10, "Access is enforced", "member Marie: uses analytics (entitlement ✓ role ✓) but cannot cancel (role ✗ FORBIDDEN); Globex on Free: analytics refused (entitlement ✗). AuthBoundry gates delegated spending (step 17)");

    // 11–12. Consumption, attributed and metered.
    const project = await c.mutation(api.workspace.createProject, { name: "Funnel" });
    for (let i = 0; i < 5; i++) await c.mutation(api.workspace.runExport, { projectId: project, format: "csv", idempotencyKey: `acc-export-${i}` });
    for (let i = 0; i < 3; i++) await marie.mutation(api.workspace.runExport, { projectId: project, format: "pdf", idempotencyKey: `acc-marie-${i}` });
    step(11, "The customer consumes application capabilities", "1 project created; 8 exports run by two people");
    const usage = (await c.query(api.usage.summary, {})).meters.find((m) => m.meter === "exports")!;
    assert.deepEqual(usage.byActor.map((a) => [a.actorId, a.quantity]).sort(), [["grace", 5], ["marie", 3]]);
    step(12, "Usage is attributed and metered", usage.byActor.map((a) => `${a.actorType}:${a.actorId}=${a.quantity}`).join(", ") + `; counter ${usage.used}/${usage.allowance}`);

    // 13–14. Approaching the allowance notifies.
    const backend = t.as({ id: "reporting-backend", type: "service", roles: ["usage_reporter"] }, { session: false });
    await backend.mutation(api.usage.ingest, { accountId, meter: "exports", quantity: 395, idempotencyKey: "acc-batch-1" });
    step(13, "The customer approaches the allowance", `403/500 exports (80%+)`);
    let inbox = (await c.query(api.inbox.list, {})).map((n) => n.type);
    assert.ok(inbox.includes("usage.threshold"));
    step(14, "The system notifies the customer", `notifications: ${[...new Set(inbox)].join(", ")}`);

    // 15–16. Exceeding it applies the overage policy (Pro: charge 5¢ per export).
    await backend.mutation(api.usage.ingest, { accountId, meter: "exports", quantity: 97, idempotencyKey: "acc-batch-2" });
    const over = await c.mutation(api.workspace.runExport, { projectId: project, format: "csv", idempotencyKey: "acc-over-1" });
    assert.deepEqual([over.disposition, over.estimatedCost], ["overage", 5]);
    inbox = (await c.query(api.inbox.list, {})).map((n) => n.type);
    assert.ok(inbox.includes("usage.exhausted") && inbox.includes("usage.overage"));
    step(15, "The customer exceeds the allowance", `export #501 → disposition ${over.disposition}; notified ${["usage.exhausted", "usage.overage"].join(", ")}`);
    const s2 = (await c.query(api.billing.summary, {}))!;
    assert.equal(s2.upcoming!.overage, 5);
    step(16, "The configured overage policy is applied", `Pro policy "charge": ${s2.upcoming!.overage}¢ accrued, billed on the next invoice (Free would have refused)`);

    // 17–18. An agent works for the customer, within delegated authority.
    const bot = await addAgent(t, accountId, "agent-analyst");
    await c.mutation(api.agents.setPolicy, { agentId: "agent-analyst", enabled: true, budgetPerPeriod: 100, perOperationLimit: 20, meters: ["agent.executions"], mayRequestPurchases: true });
    await c.mutation(api.agents.delegateSpending, {});
    await backend.mutation(api.usage.ingest, { accountId, meter: "agent.executions", quantity: 1000, idempotencyKey: "acc-agent-fill" });
    const run = await bot.mutation(api.workspace.agentExecute, { task: "Summarize churn drivers", idempotencyKey: "acc-agent-run-1" });
    assert.deepEqual([run.disposition, run.estimatedCost], ["overage", 10]);
    step(17, "An agent performs authorized work", `role agent ✓, plan agents.enabled ✓, policy budget 100¢ ✓, AuthBoundry delegation ✓ → run ${run.disposition}, ${run.estimatedCost}¢`);
    const agentRow = (await c.query(api.usage.summary, {})).meters.find((m) => m.meter === "agent.executions")!.byActor.find((a) => a.actorId === "agent-analyst")!;
    assert.deepEqual([agentRow.actorType, agentRow.onBehalfOf], ["agent", "grace"]);
    const agentTrail = await ada.query(api.ops.auditTrail, { subject: "agent", id: `${accountId}:agent-analyst` });
    const spent = agentTrail.find((e) => e.type === "agent.spent")!.data as Record<string, unknown>;
    step(18, "The agent's consumption is attributed", `account ${accountId}, actor agent:agent-analyst on behalf of ${agentRow.onBehalfOf}; AuthBoundry decision ${spent.authorityDecisionId}, delegation ${spent.delegationId}`);

    // 19–20. Upgrade to Business; new entitlements without a redeploy.
    const upQuote = await c.query(api.billing.quote, { planKey: "business", priceKey: "business-monthly", seats: 3 });
    const up = await c.mutation(api.billing.changePlan, { planKey: "business", priceKey: "business-monthly", seats: 3, returnUrl: RETURN });
    await gw.settle();
    const s3 = (await c.query(api.billing.summary, {}))!;
    assert.deepEqual([s3.subscription.planKey, s3.subscription.status], ["business", "active"]);
    step(19, "The customer upgrades to Business", `off-session charge of ${upQuote.total}¢ (${upQuote.lines.map((l) => `${l.kind} ${l.amount}`).join(", ")}); invoice ${up.invoiceId} paid`);
    const runtimeBefore = t.runtime;
    const e2 = await c.query(api.entitlements.list, {});
    assert.equal(e2.entitlements.find((e) => e.key === "projects.max")!.value, null);
    assert.equal(e2.entitlements.find((e) => e.key === "support.priority")!.value, true);
    assert.equal(t.runtime, runtimeBefore, "same runtime: no reload, no redeploy");
    step(20, "New entitlements take effect without redeploying", `same runtime instance; projects.max=unlimited, exports.monthly=${e2.entitlements.find((e) => e.key === "exports.monthly")!.value}, support.priority=true; Pro overage settled on the upgrade invoice`);

    // 21–23. Cancel; access continues to period end; then Free.
    const cancel = await c.mutation(api.billing.cancel, { reason: "acceptance" });
    assert.equal(cancel.status, "canceled");
    await c.query(api.workspace.advancedAnalytics, {});
    step(21, "The customer cancels", `status canceled; access until ${new Date(cancel.accessUntil).toISOString()}; analytics still allowed (end_of_period policy)`);
    const clock = t.as({ id: "component:payments", type: "service", roles: ["payments_gateway"] }, { session: false });
    const done = await clock.mutation(api.lifecycle.advance, { accountId, asOf: cancel.accessUntil + 1000 });
    await gw.settle();
    assert.ok(done.includes("cancellation completed"));
    const s4 = (await c.query(api.billing.summary, {}))!;
    assert.deepEqual([s4.subscription.planKey, s4.subscription.status], ["free", "active"]);
    step(22, "The subscription lifecycle completes", `lifecycle clock at period end: ${done.join("; ")}`);
    await rejects(c.query(api.workspace.advancedAnalytics, {}), "FAILED_PRECONDITION", "ENTITLEMENT");
    await rejects(bot.mutation(api.workspace.agentExecute, { task: "after cancel", idempotencyKey: "acc-agent-run-2" }), "FAILED_PRECONDITION", "ENTITLEMENT");
    step(23, "Access changes per the cancellation policy", "after period end: Free plan; analytics refused; agents refused (agents.enabled=false)");

    // 24. Everything auditable.
    const history = (await c.query(api.billing.history, {})).map((h) => h.type);
    for (const type of ["account.created", "subscription.purchase_started", "subscription.activated", "subscription.upgrade_started", "subscription.upgraded", "subscription.canceled", "subscription.expired", "subscription.reset_to_default"]) assert.ok(history.includes(type), type);
    const invoices = await ada.query(api.ops.invoiceList, {});
    const mine = invoices.filter((i) => i.accountId === accountId);
    const evs = (await ada.query(api.ops.events, {})).filter((e) => e.accountId === accountId);
    assert.ok(evs.every((e) => e.outcome !== "failed"));
    step(24, "All material transitions and financial events are auditable", `${history.length} audit events for the subscription/account (${[...new Set(history)].join(", ")}); invoices ${mine.map((i) => `${i.number} ${i.kind} ${i.status} ${i.total}`).join(", ")}; ${evs.length} verified provider events, none failed`);
  } finally {
    await gw.close();
    await t.close();
    mkdirSync("docs/evidence", { recursive: true });
    writeFileSync("docs/evidence/acceptance-transcript.md", `# Acceptance transcript\n\nGenerated by \`tests/acceptance.test.ts\` on ${new Date().toISOString()} (Stripe: local Stripe-compatible simulator, test mode).\n\n| # | Step | Evidence (asserted) |\n|---|---|---|\n${lines.join("\n")}\n\n${lines.length === 24 ? "All 24 steps passed." : `Stopped after step ${lines.length}: see the test output.`}\n`);
  }
});
