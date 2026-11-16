/** Payment correctness through the real payments component and the Stripe-compatible simulator. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { TestApp } from "@feltdb/feltkit/testing";
import { api, payCheckout, rejects, RETURN, setup, startGateway, workspace, type Gateway } from "./helpers.ts";

const gatewayAs = (t: TestApp) => t.as({ id: "component:payments", type: "service", roles: ["payments_gateway"] }, { session: false });

async function onPro(t: TestApp, gw: Gateway, owner = "grace") {
  const ws = await workspace(t, owner, `${owner} Inc`);
  const r = await ws.c.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
  await payCheckout(t, gw, ws.c, r.checkoutId!);
  return { ...ws, invoiceId: r.invoiceId! };
}

test("webhooks with a forged, missing or stale signature are refused before anything is recorded", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const body = JSON.stringify({ id: "evt_forged_1", type: "payment_intent.succeeded", created: Math.floor(Date.now() / 1000), data: { object: { id: "pi_x", amount: 2900, amount_received: 2900, currency: "usd", metadata: { invoiceId: "nope" } } } });
    const ts = Math.floor(Date.now() / 1000);
    const wrong = `t=${ts},v1=${createHmac("sha256", "whsec_attacker").update(`${ts}.${body}`).digest("hex")}`;
    assert.equal((await gw.post("/stripe/webhook", body, { "stripe-signature": wrong })).status, 400);
    assert.equal((await gw.post("/stripe/webhook", body)).status, 400);
    const old = ts - 3600;
    assert.equal((await gw.post("/stripe/webhook", body, { "stripe-signature": `t=${old},v1=${createHmac("sha256", "x").update(`${old}.${body}`).digest("hex")}` })).status, 400);
    const status = await gw.get("/stripe/status");
    assert.equal(status.body.stats.rejected, 3);
    assert.equal((await t.as("ada").query(api.ops.events, {})).length, 0, "nothing recorded");
  } finally {
    await gw.close();
    await t.close();
  }
});

test("a redelivered event is applied once", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const { c, invoiceId } = await onPro(t, gw);
    const events = (await gw.get("/stripe/sim/events")).body.events as Array<{ id: string; type: string }>;
    const paid = events.find((e) => e.type === "payment_intent.succeeded")!;
    for (let i = 0; i < 3; i++) assert.equal((await gw.post(`/stripe/sim/events/${paid.id}/redeliver`)).body.status, 200);
    const recorded = (await t.as("ada").query(api.ops.events, {})).filter((e) => e.eventId === paid.id);
    assert.equal(recorded.length, 1);
    const invoices = await c.query(api.billing.invoiceList, {});
    assert.equal(invoices.find((i) => i.id === invoiceId)!.amountPaid, 2900);
    const history = await c.query(api.billing.history, {});
    assert.equal(history.filter((h) => h.type === "subscription.activated").length, 1);
  } finally {
    await gw.close();
    await t.close();
  }
});

test("events delivered out of order reach the same state", async () => {
  process.env.STRIPE_SIM_REVERSE = "1";
  const t = await setup();
  const gw = await startGateway(t);
  delete process.env.STRIPE_SIM_REVERSE;
  try {
    const { c } = await onPro(t, gw);
    const deliveries = (await gw.get("/stripe/sim/events")).body.deliveries as Array<{ type: string }>;
    assert.equal(deliveries[0]!.type, "payment_intent.succeeded", "payment arrived before checkout completion");
    const s = await c.query(api.billing.summary, {});
    assert.deepEqual([s!.subscription.planKey, s!.subscription.status, s!.account.paymentMethod?.last4], ["pro", "active", "4242"]);
  } finally {
    await gw.close();
    await t.close();
  }
});

test("a payment that does not match its invoice grants nothing and is flagged", async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t);
    const r = await c.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
    const gateway = gatewayAs(t);
    const out = await gateway.mutation(api.payments.ingest, { event: { provider: "stripe", eventId: "evt_short", type: "payment.succeeded", providerType: "payment_intent.succeeded", created: Date.now(), invoiceId: r.invoiceId, accountId, amount: 100, currency: "usd", paymentRef: "pi_short" } });
    assert.equal(out.outcome, "failed");
    assert.equal((await c.query(api.billing.summary, {}))!.subscription.planKey, "free");
    const wrongAccount = await gateway.mutation(api.payments.ingest, { event: { provider: "stripe", eventId: "evt_cross", type: "payment.succeeded", providerType: "payment_intent.succeeded", created: Date.now(), invoiceId: r.invoiceId, accountId: "someone-else", amount: 2900, currency: "usd", paymentRef: "pi_cross" } });
    assert.equal(wrongAccount.outcome, "failed");
    assert.equal((await c.query(api.billing.summary, {}))!.subscription.planKey, "free");
    const anomalies = await t.as("ada").query(api.ops.anomalies, {});
    assert.equal(anomalies.filter((a) => a.kind === "provider_event_failed").length, 2);
    // A late failure for an invoice that was then paid is stale, not applied.
    await gateway.mutation(api.payments.ingest, { event: { provider: "stripe", eventId: "evt_ok", type: "payment.succeeded", providerType: "payment_intent.succeeded", created: Date.now(), invoiceId: r.invoiceId, accountId, amount: 2900, currency: "usd", paymentRef: "pi_ok" } });
    const late = await gateway.mutation(api.payments.ingest, { event: { provider: "stripe", eventId: "evt_late_fail", type: "payment.failed", providerType: "payment_intent.payment_failed", created: Date.now() - 60_000, invoiceId: r.invoiceId, accountId, amount: 2900, currency: "usd", paymentRef: "pi_old", failureReason: "card_declined" } });
    assert.equal(late.outcome, "stale");
    assert.equal((await c.query(api.billing.summary, {}))!.subscription.status, "active");
  } finally {
    await t.close();
  }
});

test("a declined card at checkout changes nothing; the purchase can be abandoned", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const { c } = await workspace(t);
    const r = await c.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
    const paid = await payCheckout(t, gw, c, r.checkoutId!, "pm_card_chargeDeclined");
    assert.equal(paid.status, "declined");
    let s = await c.query(api.billing.summary, {});
    assert.equal(s!.subscription.planKey, "free");
    assert.equal(s!.subscription.pending?.invoiceId, r.invoiceId);
    await rejects(c.mutation(api.billing.changePlan, { planKey: "business", priceKey: "business-monthly", returnUrl: RETURN }), "FAILED_PRECONDITION", "PENDING_CHANGE");
    await c.mutation(api.billing.abandonPending, {});
    s = await c.query(api.billing.summary, {});
    assert.equal(s!.subscription.pending, null);
    assert.equal((await c.query(api.billing.invoiceList, {})).find((i) => i.id === r.invoiceId)!.status, "void");
  } finally {
    await gw.close();
    await t.close();
  }
});

test("upgrading with a saved card charges the prorated difference off-session; refunds settle by event", async () => {
  const t = await setup();
  const gw = await startGateway(t);
  try {
    const { c } = await onPro(t, gw);
    const q = await c.query(api.billing.quote, { planKey: "business", priceKey: "business-monthly", seats: 3 });
    assert.equal(q.kind, "upgrade");
    assert.ok(q.total > 0 && q.total <= 6000 - 0, `prorated ${q.total}`);
    const up = await c.mutation(api.billing.changePlan, { planKey: "business", priceKey: "business-monthly", seats: 3, returnUrl: RETURN });
    assert.equal(up.charged, true, "no checkout: the card on file is charged");
    await gw.settle();
    const s = await c.query(api.billing.summary, {});
    assert.deepEqual([s!.subscription.planKey, s!.subscription.seats, s!.subscription.status], ["business", 3, "active"]);
    const inv = (await c.query(api.billing.invoiceList, {})).find((i) => i.id === up.invoiceId)!;
    assert.equal(inv.status, "paid");
    assert.equal(inv.total, q.total, "the quote is what was charged");
    assert.deepEqual(inv.lines.map((l) => l.kind), ["proration_credit", "proration_charge"]);

    const refundId = await t.as("ada").mutation(api.ops.refund, { invoiceId: up.invoiceId!, amount: 500, reason: "goodwill" });
    await gw.settle();
    const after = (await c.query(api.billing.invoiceList, {})).find((i) => i.id === up.invoiceId)!;
    assert.equal(after.amountRefunded, 500);
    assert.equal((await c.query(api.billing.refundList, {})).find((r) => r.id === refundId)!.state, "succeeded");
    await rejects(t.as("ada").mutation(api.ops.refund, { invoiceId: up.invoiceId!, amount: inv.total, reason: "too much" }), "FAILED_PRECONDITION");

    // Reconciliation reads the provider and changes nothing that is already right.
    assert.ok((await t.as("ada").mutation(api.ops.reconcile, { invoiceId: up.invoiceId! })) >= 1);
    await gw.settle();
    const trail = await t.as("ada").query(api.ops.auditTrail, { subject: "invoice", id: up.invoiceId! });
    assert.ok(trail.some((e) => e.type === "invoice.reconciled" && (e.data as { providerStatus: string }).providerStatus === "succeeded"));
    assert.equal(trail.filter((e) => e.type === "invoice.paid").length, 1, "not paid twice");
  } finally {
    await gw.close();
    await t.close();
  }
});

test("reconciliation applies a payment the event stream missed", async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t);
    const r = await c.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: RETURN });
    await gatewayAs(t).mutation(api.payments.workResult, { result: { kind: "payment.observed", invoiceId: r.invoiceId, paymentRef: "pi_seen_by_api", status: "succeeded", amount: 2900, currency: "usd" } });
    const s = await c.query(api.billing.summary, {});
    assert.deepEqual([s!.subscription.planKey, s!.subscription.status], ["pro", "active"]);
    const trail = await t.as("ada").query(api.ops.auditTrail, { subject: "invoice", id: r.invoiceId! });
    assert.ok(trail.some((e) => e.type === "invoice.paid" && String((e.data as { evidence: string }).evidence).startsWith("reconciliation:")));
    void accountId;
  } finally {
    await t.close();
  }
});
