/** Time-driven lifecycle: renewals, overage billing, dunning, grace, suspension, recovery, downgrades, cancellation, trials, catalog versions. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestApp } from "@feltdb/feltkit/testing";
import { api, payCheckout, rejects, RETURN, setup, startGateway, workspace, type Gateway } from "./helpers.ts";

const DAY = 86_400_000;
const clockAs = (t: TestApp) => t.as({ id: "component:payments", type: "service", roles: ["payments_gateway"] }, { session: false });

async function onPro(t: TestApp, gw: Gateway) {
  const ws = await workspace(t);
  const r = await ws.c.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
  await payCheckout(t, gw, ws.c, r.checkoutId!);
  return ws;
}
async function advance(t: TestApp, gw: Gateway, accountId: string, asOf: number) {
  const done = await clockAs(t).mutation(api.lifecycle.advance, { accountId, asOf });
  await gw.settle();
  return done;
}
async function customerRef(t: TestApp, accountId: string) {
  return (await t.as("ada").query(api.ops.accountDetail, { accountId })).account.providerCustomerRef!;
}

test("renewal bills the next period plus the ended period's overage, from the authoritative counters", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const { c, accountId } = await onPro(t, gw);
    const backend = t.as({ id: "backend", type: "service", roles: ["usage_reporter"] }, { session: false });
    await backend.mutation(api.usage.ingest, { accountId, meter: "exports", quantity: 520, idempotencyKey: "bulk-exports" });
    await backend.mutation(api.usage.ingest, { accountId, meter: "api.requests", quantity: 100_500, idempotencyKey: "bulk-api" });
    const before = await c.query(api.billing.summary, {});
    assert.equal(before!.upcoming!.overage, 20 * 5 + 100, "20 exports at 5¢ + one 1k block of API at $1");
    const end = before!.subscription.currentPeriodEnd;

    const notice = await advance(t, gw, accountId, end - 2 * DAY);
    assert.ok(notice.includes("renewal notice"));
    assert.deepEqual(await advance(t, gw, accountId, end - 2 * DAY), [], "idempotent: nothing more is due");

    const done = await advance(t, gw, accountId, end + 1000);
    assert.ok(done.some((d) => d.startsWith("renewed")), done.join());
    const renewal = (await c.query(api.billing.invoiceList, {})).find((i) => i.kind === "renewal")!;
    assert.equal(renewal.status, "paid");
    assert.equal(renewal.total, 2900 + 200);
    assert.deepEqual(renewal.lines.map((l) => l.kind).sort(), ["overage", "overage", "subscription"]);
    const after = await c.query(api.billing.summary, {});
    assert.equal(after!.subscription.currentPeriodStart, end);
    assert.equal(after!.usage.find((u) => u.meter === "exports")!.used, 0, "the new period starts empty");
    assert.deepEqual(await advance(t, gw, accountId, end + 2000), [], "renewing twice is impossible");
  } finally {
    await gw.close();
    await t.close();
  }
});

test("a failed renewal enters grace, then suspension (access falls back), and a new card recovers it", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const { c, accountId } = await onPro(t, gw);
    await gw.post(`/stripe/sim/customers/${await customerRef(t, accountId)}/behavior`, { card: "decline" });
    const end = (await c.query(api.billing.summary, {}))!.subscription.currentPeriodEnd;
    await advance(t, gw, accountId, end + 1000);
    let s = await c.query(api.billing.summary, {});
    assert.equal(s!.subscription.status, "past_due");
    assert.equal(s!.openInvoices[0]!.attempts, 1);
    assert.ok(s!.subscription.graceUntil! > end);
    await c.query(api.workspace.advancedAnalytics, {}); // still Pro during grace
    // Dunning: retried a day later, fails again.
    await advance(t, gw, accountId, end + DAY + 2000);
    s = await c.query(api.billing.summary, {});
    assert.equal(s!.openInvoices[0]!.attempts, 2);
    // Grace (7 days) ends: suspended, entitlements fall back to Free.
    await advance(t, gw, accountId, end + 8 * DAY);
    s = await c.query(api.billing.summary, {});
    assert.equal(s!.subscription.status, "suspended");
    assert.equal(s!.effectivePlan.key, "free");
    await rejects(c.query(api.workspace.advancedAnalytics, {}), "FAILED_PRECONDITION", "ENTITLEMENT");
    // The customer saves a working card: the open renewal is retried at once and access returns.
    await gw.post(`/stripe/sim/customers/${await customerRef(t, accountId)}/behavior`, { card: "ok" });
    const { checkoutId } = await c.mutation(api.billing.updatePaymentMethod, { returnUrl: RETURN });
    await payCheckout(t, gw, c, checkoutId, "pm_card_mastercard");
    s = await c.query(api.billing.summary, {});
    assert.deepEqual([s!.subscription.status, s!.effectivePlan.key, s!.account.paymentMethod?.last4], ["active", "pro", "4444"]);
    const notes = (await c.query(api.inbox.list, {})).map((n) => n.type);
    for (const type of ["payment.failed", "subscription.suspended", "payment.succeeded"]) assert.ok(notes.includes(type), `${type} missing from ${JSON.stringify(notes)}`);
    const history = (await c.query(api.billing.history, {})).map((h) => h.type);
    for (const type of ["subscription.past_due", "subscription.suspended", "subscription.recovered"]) assert.ok(history.includes(type), type);
  } finally {
    await gw.close();
    await t.close();
  }
});

test("downgrades wait for the period end; cancellation keeps access until then, then returns to Free", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const { c, accountId } = await onPro(t, gw);
    const up = await c.mutation(api.billing.changePlan, { planKey: "business", priceKey: "business-monthly", seats: 3, returnUrl: RETURN });
    assert.equal(up.charged, true);
    await gw.settle();
    const down = await c.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
    assert.equal(down.effective, "period_end");
    let s = await c.query(api.billing.summary, {});
    assert.equal(s!.subscription.planKey, "business");
    assert.equal(s!.upcoming!.subscription, 2900, "the next bill is the downgraded plan");
    const end = s!.subscription.currentPeriodEnd;
    await advance(t, gw, accountId, end + 1000);
    s = await c.query(api.billing.summary, {});
    assert.equal(s!.subscription.planKey, "pro");

    const canceled = await c.mutation(api.billing.cancel, { reason: "budget" });
    assert.equal(canceled.status, "canceled");
    await c.query(api.workspace.advancedAnalytics, {}); // paid-through access continues
    await c.mutation(api.billing.resume, {});
    await c.mutation(api.billing.cancel, { reason: "budget, really" });
    const end2 = (await c.query(api.billing.summary, {}))!.subscription.currentPeriodEnd;
    const done = await advance(t, gw, accountId, end2 + 1000);
    assert.ok(done.includes("cancellation completed"));
    s = await c.query(api.billing.summary, {});
    assert.deepEqual([s!.subscription.planKey, s!.subscription.status], ["free", "active"]);
    await rejects(c.query(api.workspace.advancedAnalytics, {}), "FAILED_PRECONDITION", "ENTITLEMENT");
    const history = (await c.query(api.billing.history, {})).map((h) => h.type);
    for (const type of ["subscription.downgrade_scheduled", "subscription.canceled", "subscription.resumed", "subscription.expired", "subscription.reset_to_default"]) assert.ok(history.includes(type), type);
  } finally {
    await gw.close();
    await t.close();
  }
});

test("a trial grants the plan without a card, warns before it ends, and falls back without one", async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t);
    const { trialEnd } = await c.mutation(api.billing.startTrial, { planKey: "pro", priceKey: "pro-monthly" });
    assert.equal((await c.query(api.billing.summary, {}))!.subscription.status, "trialing");
    await c.query(api.workspace.advancedAnalytics, {});
    assert.ok((await clockAs(t).mutation(api.lifecycle.advance, { accountId, asOf: trialEnd - DAY })).includes("trial ending notice"));
    assert.ok((await clockAs(t).mutation(api.lifecycle.advance, { accountId, asOf: trialEnd + 1 })).includes("trial ended → default plan"));
    assert.equal((await c.query(api.billing.summary, {}))!.subscription.planKey, "free");
    await rejects(c.mutation(api.billing.startTrial, { planKey: "pro", priceKey: "pro-monthly" }), "FAILED_PRECONDITION", "TRIAL_USED");
  } finally {
    await t.close();
  }
});

test("catalog changes never rewrite existing customers: grandfathering, explicit migration, rollback", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const ada = t.as("ada");
    const { c, accountId } = await onPro(t, gw);
    // v2: Pro costs more and includes more exports.
    await ada.mutation(api.catalog.createDraft, {});
    const draft = (await ada.query(api.catalog.draft, {}))!;
    const doc = structuredClone(draft.document);
    const pro = doc.plans.find((p) => p.key === "pro")!;
    pro.prices[0]!.unitAmount = 3900;
    pro.entitlements["exports.monthly"] = 1000;
    doc.plans.find((p) => p.key === "free")!.isDefault = false;
    assert.ok((await ada.mutation(api.catalog.saveDraft, { document: doc })).problems.length > 0);
    await rejects(ada.mutation(api.catalog.publish, {}), "FAILED_PRECONDITION");
    doc.plans.find((p) => p.key === "free")!.isDefault = true;
    assert.deepEqual((await ada.mutation(api.catalog.saveDraft, { document: doc })).problems, []);
    assert.equal((await ada.mutation(api.catalog.publish, { migration: "grandfather" })).version, 2);
    const changes = await ada.query(api.catalog.diff, { from: 1, to: 2 });
    assert.ok(changes.some((x) => x.kind === "price.changed"));

    // The existing customer keeps v1 terms; a new customer gets v2.
    let s = await c.query(api.billing.summary, {});
    assert.deepEqual([s!.subscription.catalogVersion, s!.entitlements.find((e) => e.key === "exports.monthly")!.value, s!.upcoming!.subscription], [1, 500, 2900]);
    const newcomer = await workspace(t, "linus", "Globex");
    assert.equal((await newcomer.c.query(api.billing.quote, { planKey: "pro", priceKey: "pro-monthly" })).total, 3900);

    // An explicit migration moves them at their next renewal, never mid-period.
    const m = await ada.mutation(api.ops.scheduleMigration, { fromVersion: 1 });
    assert.equal(m.scheduled, 1, "only grace is on v1; the newcomer started on v2");
    s = await c.query(api.billing.summary, {});
    assert.equal(s!.subscription.catalogVersion, 1);
    await advance(t, gw, accountId, s!.subscription.currentPeriodEnd + 1000);
    s = await c.query(api.billing.summary, {});
    assert.deepEqual([s!.subscription.catalogVersion, s!.entitlements.find((e) => e.key === "exports.monthly")!.value], [2, 1000]);
    assert.equal((await c.query(api.billing.invoiceList, {})).find((i) => i.kind === "renewal")!.total, 3900);

    // Rollback publishes the old document as a new version; history is untouched.
    const rb = await ada.mutation(api.catalog.rollback, { toVersion: 1, reason: "pricing test ended" });
    assert.equal(rb.version, 3);
    const versions = await ada.query(api.catalog.versions, {});
    assert.equal(versions.find((v) => v.version === 3)!.digest, versions.find((v) => v.version === 1)!.digest);
    assert.equal(versions.find((v) => v.version === 2)!.state, "published");
    assert.equal((await c.query(api.billing.summary, {}))!.subscription.catalogVersion, 2, "rollback does not touch subscriptions");
  } finally {
    await gw.close();
    await t.close();
  }
});

test("an upgrade settles overage accrued under the old terms; it is never forgiven or billed twice", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const { c, accountId } = await onPro(t, gw);
    const backend = t.as({ id: "backend", type: "service", roles: ["usage_reporter"] }, { session: false });
    await backend.mutation(api.usage.ingest, { accountId, meter: "exports", quantity: 520, idempotencyKey: "pro-exports" });
    const q = await c.query(api.billing.quote, { planKey: "business", priceKey: "business-monthly", seats: 3 });
    const over = q.lines.find((l) => l.kind === "overage")!;
    assert.equal(over.amount, 100, "20 exports at Pro's 5¢");
    const up = await c.mutation(api.billing.changePlan, { planKey: "business", priceKey: "business-monthly", seats: 3, returnUrl: RETURN });
    await gw.settle();
    assert.equal((await c.query(api.billing.invoiceList, {})).find((i) => i.id === up.invoiceId)!.status, "paid");
    assert.equal((await c.query(api.billing.summary, {}))!.upcoming!.overage, 0, "nothing left unbilled under Business");
    // Past Business's 5000 later in the same period: only the new excess is billed, at Business rates.
    await backend.mutation(api.usage.ingest, { accountId, meter: "exports", quantity: 4580, idempotencyKey: "biz-exports" });
    assert.equal((await c.query(api.billing.summary, {}))!.upcoming!.overage, 100 * 2 - 20 * 2, "5100 used − 5000 included − 20 already billed = 80 at 2¢");
    const end = (await c.query(api.billing.summary, {}))!.subscription.currentPeriodEnd;
    await advance(t, gw, accountId, end + 1000);
    const renewal = (await c.query(api.billing.invoiceList, {})).find((i) => i.kind === "renewal")!;
    assert.equal(renewal.lines.find((l) => l.kind === "overage")!.amount, 160);
  } finally {
    await gw.close();
    await t.close();
  }
});
