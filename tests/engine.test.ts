/** The decision engine: pure money and access math, no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogDiff, catalogProblems, seedCatalog, type Catalog } from "../feltkit/_catalog.ts";
import { addInterval, canTransition, crossedThresholds, decide, effectiveEntitlements, overageCharge, periodAmount, prorate, TRANSITIONS } from "../feltkit/_engine.ts";

const catalog = seedCatalog();
const ent = (plan: string, status = "active" as const, grants = [] as Parameters<typeof effectiveEntitlements>[2], principal?: { type: string; id: string }) =>
  effectiveEntitlements(catalog, { planKey: plan, status, periodKey: "p:1" }, grants, 1_000, principal);
const get = (r: ReturnType<typeof ent>, key: string) => r.entitlements.find((e) => e.key === key)!;

test("the seed catalog is publishable, and broken catalogs say why", () => {
  assert.deepEqual(catalogProblems(catalog), []);
  const broken: Catalog = structuredClone(catalog);
  broken.plans[0]!.isDefault = false;
  broken.plans[1]!.entitlements["nope.feature"] = true;
  broken.plans[1]!.overage.push({ meter: "ghost", policy: "charge" });
  broken.plans[2]!.entitlements["analytics.advanced"] = 5;
  const problems = catalogProblems(broken);
  assert.ok(problems.some((p) => p.includes("Exactly one plan must be the default")));
  assert.ok(problems.some((p) => p.includes('unknown feature "nope.feature"')));
  assert.ok(problems.some((p) => p.includes('unknown meter "ghost"')));
  assert.ok(problems.some((p) => p.includes("is a boolean feature")));
});

test("plans grant entitlements; lapsed subscriptions fall back to the default plan", () => {
  assert.equal(get(ent("pro"), "analytics.advanced").value, true);
  assert.equal(get(ent("free"), "analytics.advanced").value, false);
  assert.equal(get(ent("business"), "projects.max").value, null, "null is unlimited");
  for (const status of ["suspended", "expired", "incomplete"] as const) {
    const r = ent("pro", status as never);
    assert.equal(r.onDefault, true, status);
    assert.equal(get(r, "analytics.advanced").value, false, status);
  }
  for (const status of ["trialing", "past_due", "canceled"] as const) assert.equal(ent("pro", status as never).onDefault, false, status);
});

test("overrides replace, grants and add-ons add, scoped and expired grants apply only where they should", () => {
  const r = ent("pro", "active", [
    { feature: "exports.monthly", kind: "addon", value: 1000, periodKey: "p:1" },
    { feature: "exports.monthly", kind: "addon", value: 999, periodKey: "p:0" },
    { feature: "projects.max", kind: "override", value: 40 },
    { feature: "projects.max", kind: "grant", value: 5 },
    { feature: "storage.max_gb", kind: "grant", value: 10, expiresAt: 500 },
    { feature: "support.priority", kind: "grant", value: true, revokedAt: 900 },
    { feature: "agents.executions.monthly", kind: "grant", value: 50, scope: { type: "agent", id: "bot" } },
  ]);
  assert.equal(get(r, "exports.monthly").value, 1500, "this period's add-on only");
  assert.equal(get(r, "projects.max").value, 45, "override then grant");
  assert.equal(get(r, "storage.max_gb").value, 50, "expired grant ignored");
  assert.equal(get(r, "support.priority").value, false, "revoked grant ignored");
  assert.equal(get(r, "agents.executions.monthly").value, 1000, "agent-scoped grant not for the account");
  const asBot = ent("pro", "active", [{ feature: "agents.executions.monthly", kind: "grant", value: 50, scope: { type: "agent", id: "bot" } }], { type: "agent", id: "bot" });
  assert.equal(get(asBot, "agents.executions.monthly").value, 1050);
});

test("decisions: boolean, limit, rate, allowance, overage, caps", () => {
  const pro = ent("pro");
  const free = ent("free");
  assert.equal(decide(get(free, "analytics.advanced"), 1, {}).code, "not_entitled");
  assert.equal(decide(get(free, "projects.max"), 1, { count: 2 }).allowed, true);
  assert.equal(decide(get(free, "projects.max"), 1, { count: 3 }).code, "limit_reached");
  assert.equal(decide(get(free, "api.requests.per_minute"), 1, { count: 10 }).code, "rate_limited");
  // Free blocks at the allowance.
  assert.equal(decide(get(free, "exports.monthly"), 1, { used: 9 }).code, "included");
  const blocked = decide(get(free, "exports.monthly"), 1, { used: 10 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, "allowance_exhausted");
  // Reserved capacity counts as spoken for.
  assert.equal(decide(get(free, "exports.monthly"), 1, { used: 5, reserved: 5 }).allowed, false);
  // Pro charges overage: 5 cents per export past 500.
  const over = decide(get(pro, "exports.monthly"), 3, { used: 499 });
  assert.equal(over.code, "overage");
  assert.equal(over.overageUnits, 2);
  assert.equal(over.estimatedCost, 10);
  // Per-1000 pricing charges a block once it is entered.
  assert.equal(decide(get(pro, "api.requests.monthly"), 1, { used: 100_000 }).estimatedCost, 100);
  assert.equal(decide(get(pro, "api.requests.monthly"), 1, { used: 100_001 }).estimatedCost, 0);
  // Hard cap.
  assert.equal(decide(get(pro, "exports.monthly"), 1, { used: 5500 }).allowed, false);
});

test("rating: per-seat minimums, proration never credits more than was paid, overage blocks", () => {
  const business = catalog.plans.find((p) => p.key === "business")!;
  assert.equal(periodAmount(business.prices[0]!, 1), 6000, "3-seat minimum");
  assert.equal(periodAmount(business.prices[0]!, 5), 10_000);
  const half = prorate(2900, 6000, 0, 1000, 500);
  assert.deepEqual([half.credit, half.charge, half.net], [1450, 3000, 1550]);
  const odd = prorate(2900, 6000, 0, 3, 1);
  assert.ok(odd.credit <= Math.floor((2900 * 2) / 3) && odd.charge >= Math.ceil((6000 * 2) / 3) - 0);
  assert.deepEqual(prorate(2900, 6000, 0, 1000, 2000), { fraction: 0, credit: 0, charge: 0, net: 0 }, "after the period ends nothing is prorated");
  assert.deepEqual(overageCharge(500, 520, { meter: "exports", policy: "charge", unitAmount: 5, perUnits: 1 }), { units: 20, amount: 100 });
  assert.deepEqual(overageCharge(500, 520, { meter: "exports", policy: "allow" }), { units: 20, amount: 0 });
  assert.deepEqual(overageCharge(null, 10_000, { meter: "exports", policy: "charge", unitAmount: 5, perUnits: 1 }), { units: 0, amount: 0 });
});

test("calendar periods clamp to month ends", () => {
  const jan31 = Date.UTC(2026, 0, 31, 12);
  assert.equal(new Date(addInterval(jan31, "month")).toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(new Date(addInterval(Date.UTC(2028, 1, 29), "year")).toISOString(), "2029-02-28T00:00:00.000Z");
});

test("the lifecycle refuses impossible transitions", () => {
  assert.equal(canTransition("expired", "active"), false);
  assert.equal(canTransition("incomplete", "past_due"), false);
  assert.equal(canTransition("past_due", "suspended"), true);
  assert.equal(canTransition("canceled", "active"), true, "resume");
  for (const [from, tos] of Object.entries(TRANSITIONS)) for (const to of tos) assert.ok(canTransition(from as never, to), `${from}→${to}`);
});

test("usage thresholds fire once each", () => {
  assert.deepEqual(crossedThresholds(100, 79, 80, []), [0.8]);
  assert.deepEqual(crossedThresholds(100, 79, 100, []), [0.8, 1]);
  assert.deepEqual(crossedThresholds(100, 85, 90, [0.8]), []);
  assert.deepEqual(crossedThresholds(null, 0, 1e9, []), []);
});

test("catalog diffs describe commercial changes", () => {
  const next: Catalog = structuredClone(catalog);
  next.plans[1]!.prices[0]!.unitAmount = 3900;
  next.plans[1]!.entitlements["exports.monthly"] = 1000;
  const changes = catalogDiff(catalog, next);
  assert.ok(changes.some((c) => c.kind === "price.changed" && c.detail === "2900 → 3900"));
  assert.ok(changes.some((c) => c.kind === "entitlement.changed" && c.key === "pro/exports.monthly"));
});
