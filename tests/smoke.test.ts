import { test } from "node:test";
import assert from "node:assert/strict";
import { api, payCheckout, rejects, RETURN, setup, startGateway, workspace } from "./helpers.ts";

test("smoke: free limits, checkout to Pro through the payments component, new entitlements", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const { c } = await workspace(t);
    const s0 = await c.query(api.billing.summary, {});
    assert.equal(s0!.subscription.planKey, "free");
    const p = await c.mutation(api.workspace.createProject, { name: "Launch" });
    for (let i = 0; i < 10; i++) await c.mutation(api.workspace.runExport, { projectId: p, format: "csv", idempotencyKey: `smoke-export-${i}` });
    await rejects(c.mutation(api.workspace.runExport, { projectId: p, format: "csv", idempotencyKey: "smoke-export-10" }), "FAILED_PRECONDITION", "ENTITLEMENT");
    await rejects(c.query(api.workspace.advancedAnalytics, {}), "FAILED_PRECONDITION", "ENTITLEMENT");

    const change = await c.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
    assert.equal(change.kind, "new");
    assert.ok(change.checkoutId);
    const paid = await payCheckout(t, gw, c, change.checkoutId!);
    assert.equal(paid.status, "complete");
    const s1 = await c.query(api.billing.summary, {});
    assert.equal(s1!.subscription.planKey, "pro", JSON.stringify(s1!.subscription));
    assert.equal(s1!.subscription.status, "active");
    assert.equal(s1!.account.paymentMethod?.last4, "4242");
    const a = await c.query(api.workspace.advancedAnalytics, {});
    assert.ok(a.cohorts.length > 0);
  } finally {
    await gw.close();
    await t.close();
  }
});
