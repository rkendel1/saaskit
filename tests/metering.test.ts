/** Metering and enforcement: concurrency, idempotency, reservations, rate limits, isolation, roles. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, rejects, retrying, setup, workspace } from "./helpers.ts";

test("concurrent consumers never overspend an allowance or lose an increment", async () => {
  const t = await setup();
  try {
    const { c } = await workspace(t);
    const p = await c.mutation(api.workspace.createProject, { name: "P" });
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => retrying(() => c.mutation(api.workspace.runExport, { projectId: p, format: "csv", idempotencyKey: `conc-export-${i}` }))));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code);
    assert.equal(ok, 10, "exactly the free allowance");
    assert.deepEqual([...new Set(refused)], ["FAILED_PRECONDITION"], "the rest are refused by entitlement, not lost to conflicts");
    const usage = await c.query(api.usage.summary, {});
    const exports = usage.meters.find((m) => m.meter === "exports")!;
    assert.equal(exports.used, 10);
    assert.equal((await c.query(api.usage.recent, { limit: 200 })).filter((e) => e.meter === "exports").length, 10, "events and counter agree");
  } finally {
    await t.close();
  }
});

test("a repeated idempotency key records usage once, even when the repeats race", async () => {
  const t = await setup();
  try {
    const { c } = await workspace(t);
    const p = await c.mutation(api.workspace.createProject, { name: "P" });
    const runs = await Promise.all(Array.from({ length: 6 }, () => retrying(() => c.mutation(api.workspace.runExport, { projectId: p, format: "pdf", idempotencyKey: "same-click-123" }))));
    assert.equal(new Set(runs.map((r) => r.exportId)).size, 1, "one event");
    assert.equal(runs.filter((r) => !r.duplicate).length, 1);
    const s = await c.query(api.usage.summary, {});
    assert.equal(s.meters.find((m) => m.meter === "exports")!.used, 1);
  } finally {
    await t.close();
  }
});

test("reservations hold capacity, settle to actual use, and expire back", async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t);
    const p = await c.mutation(api.workspace.createProject, { name: "P" });
    const r = await c.mutation(api.usage.reserve, { meter: "exports", quantity: 8, idempotencyKey: "res-1", ttlSeconds: 60 });
    await c.mutation(api.workspace.runExport, { projectId: p, format: "csv", idempotencyKey: "after-res-1" });
    await c.mutation(api.workspace.runExport, { projectId: p, format: "csv", idempotencyKey: "after-res-2" });
    await rejects(c.mutation(api.workspace.runExport, { projectId: p, format: "csv", idempotencyKey: "after-res-3" }), "FAILED_PRECONDITION", "ENTITLEMENT");
    const settled = await c.mutation(api.usage.commit, { reservationId: r.reservationId, quantity: 5 });
    assert.equal(settled.released, 3);
    let s = (await c.query(api.usage.summary, {})).meters.find((m) => m.meter === "exports")!;
    assert.deepEqual([s.used, s.reserved], [7, 0]);
    // A reservation nobody settles is returned by the lifecycle clock after it expires.
    await c.mutation(api.usage.reserve, { meter: "exports", quantity: 3, idempotencyKey: "res-2", ttlSeconds: 10 });
    const gateway = t.as({ id: "component:payments", type: "service", roles: ["payments_gateway"] }, { session: false });
    const done = await gateway.mutation(api.lifecycle.advance, { accountId, asOf: Date.now() + 60_000 });
    assert.ok(done.some((d) => d.includes("expired")));
    s = (await c.query(api.usage.summary, {})).meters.find((m) => m.meter === "exports")!;
    assert.deepEqual([s.used, s.reserved], [7, 0]);
    await rejects(c.mutation(api.usage.reserve, { meter: "exports", quantity: 4, idempotencyKey: "res-3" }), "FAILED_PRECONDITION", "ENTITLEMENT");
  } finally {
    await t.close();
  }
});

test("rate limits and resource limits are enforced from the plan", async () => {
  const t = await setup();
  try {
    const { c } = await workspace(t);
    for (let i = 0; i < 10; i++) await c.mutation(api.workspace.apiCall, { endpoint: "/v1/report", idempotencyKey: `rate-call-${i}` });
    await rejects(c.mutation(api.workspace.apiCall, { endpoint: "/v1/report", idempotencyKey: "rate-call-10" }), "RATE_LIMITED");
    for (let i = 0; i < 3; i++) await c.mutation(api.workspace.createProject, { name: `P${i}` });
    const e = await rejects(c.mutation(api.workspace.createProject, { name: "P3" }), "FAILED_PRECONDITION", "ENTITLEMENT");
    assert.match(e.message!, /allows 3 projects/);
    const check = await c.query(api.entitlements.check, { feature: "projects.max" });
    assert.deepEqual([check.allowed, check.code, check.used], [false, "limit_reached", 3]);
  } finally {
    await t.close();
  }
});

test("server-reported usage is idempotent; operator adjustments are new events, audited", async () => {
  const t = await setup();
  try {
    const { c, accountId } = await workspace(t);
    const backend = t.as({ id: "billing-backend", type: "service", roles: ["usage_reporter"] }, { session: false });
    const first = await backend.mutation(api.usage.ingest, { accountId, meter: "api.requests", quantity: 250, idempotencyKey: "batch-2026-11-16-01" });
    const again = await backend.mutation(api.usage.ingest, { accountId, meter: "api.requests", quantity: 250, idempotencyKey: "batch-2026-11-16-01" });
    assert.equal(again.duplicate, true);
    assert.equal(again.eventId, first.eventId);
    await rejects(backend.mutation(api.usage.ingest, { accountId, meter: "api.requests", quantity: 999, idempotencyKey: "batch-2026-11-16-01" }), "CONFLICT", "IDEMPOTENCY_MISMATCH");
    await t.as("ada").mutation(api.usage.adjust, { accountId, meter: "api.requests", quantity: -50, reason: "duplicate batch from partner", idempotencyKey: "adj-1" });
    const u = (await c.query(api.usage.summary, {})).meters.find((m) => m.meter === "api.requests")!;
    assert.equal(u.used, 200);
    const trail = await t.as("ada").query(api.ops.auditTrail, { subject: "usage", id: `${accountId}:api.requests` });
    assert.ok(trail.some((e) => e.type === "usage.adjusted" && e.actor === "ada"));
    const recon = await t.as("ada").mutation(api.usage.reconcileCounters, { accountId });
    assert.ok(recon.every((r) => !r.repaired), "counters match the event log");
  } finally {
    await t.close();
  }
});

test("tenant isolation and role separation", async () => {
  const t = await setup();
  try {
    const grace = await workspace(t, "grace", "Acme");
    const linus = await workspace(t, "linus", "Globex");
    await grace.c.mutation(api.workspace.createProject, { name: "Acme secret" });
    assert.equal((await linus.c.query(api.workspace.listProjects, {})).length, 0, "projects are tenant-scoped");
    assert.equal((await linus.c.query(api.billing.summary, {}))!.account.accountId, linus.accountId, "billing is the session's workspace");
    // Linus cannot reach Grace's workspace by naming it.
    await rejects(t.as("linus", { tenant: grace.accountId }).query(api.billing.summary, {}), "FORBIDDEN");
    // Customers are not operators; operators' functions refuse them.
    await rejects(grace.c.query(api.ops.overview, {}), "FORBIDDEN");
    await rejects(grace.c.mutation(api.entitlements.grant, { accountId: grace.accountId, feature: "analytics.advanced", kind: "override", value: true, reason: "self-service" }), "FORBIDDEN");
    await rejects(grace.c.mutation(api.catalog.publish, {}), "FORBIDDEN");
    // A plain member uses the product but cannot change billing.
    await t.tenancy!.provision({ tenantId: grace.accountId, principal: { id: "marie", type: "user" }, role: "member" }, "ada");
    const marie = t.as({ id: "marie", type: "user", roles: ["person"] }, { tenant: grace.accountId });
    await marie.mutation(api.workspace.createProject, { name: "Marie's" });
    await rejects(marie.mutation(api.billing.cancel, {}), "FORBIDDEN");
    await rejects(marie.mutation(api.billing.changePlan, { planKey: "pro", priceKey: "pro-monthly", returnUrl: "http://localhost/x" }), "FORBIDDEN");
    // Nobody but the payments component ingests provider events.
    const forged = { provider: "stripe", eventId: "evt_forged", type: "payment.succeeded" as const, providerType: "payment_intent.succeeded", created: Date.now(), invoiceId: "x", amount: 2900, currency: "usd" };
    await rejects(grace.c.mutation(api.payments.ingest, { event: forged }), "FORBIDDEN");
    await rejects(t.as("ada").mutation(api.payments.ingest, { event: forged }), "FORBIDDEN");
  } finally {
    await t.close();
  }
});
